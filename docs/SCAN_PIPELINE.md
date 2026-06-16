# 扫描主链路工程说明

本文档描述当前「拍照/选图 → OCR → 分类增强 → 保存」的真实主流程与职责边界，基于现有代码事实。

---

## 1. 当前扫描主链路

### 入口位置

- **页面入口**：`app/(tabs)/index.tsx`（首页）
- **用户操作**：点击「扫描小票」→ 选择拍照或相册 → 单张确认或多张选择 → 触发处理

### 首页如何触发

1. `handleScanPress` 处理「扫描小票」点击：弹选择来源（拍照/相册）、请求权限、调 ImagePicker 或相机。
2. 单张：确认弹窗后调用 `processReceiptImage(uri)`。
3. 多张：确认弹窗后调用 `processMultipleReceiptImages(uris)`。
4. 两者内部都只做「逐张调用 `runScanPipeline(uri)`」；选图、权限、确认、进度条、成功/失败 Alert、复活节彩蛋均在首页编排，**不**在 pipeline 内。

### runScanPipeline 的职责

- **定义**：`lib/scanPipeline.ts` 的 `runScanPipeline(uri: string)`。
- **职责**：对单张图片执行「OCR → 分类增强 → 保存」三条，不抛错，用返回值表示成功或失败。
- **返回**：`{ ok: true }` 或 `{ ok: false, code: string, message?: string }`。`code` 与下游错误映射一致（见下文）。

### 各阶段顺序关系

```
runScanPipeline(uri)
  → analyzeReceiptImage(uri)     // lib/receiptAnalyzer.ts，内部会调 ocrService 或直连 Gemini
  → applyCategoriesWithLearning(raw)  // lib/receiptEnricher.ts，规则 + classify-item AI + 学习表
  → saveReceipt({ imageUri, analysis })  // lib/db.ts
  → return { ok: true }
```

任一步骤抛错即被 pipeline 的 try/catch 捕获，标准化为 `code` 后返回 `{ ok: false, code, message }`，**不再**执行后续步骤。

---

## 2. 各阶段职责边界

| 阶段 | 负责 | 不负责 |
|------|------|--------|
| **OCR**（analyzeReceiptImage / ocrService） | 图片压缩、上传、调用 Edge Function 或 Gemini、解析 JSON、返回 `ReceiptAnalysis`（raw） | 分类、保存、选图、UI |
| **Enrichment / 分类**（applyCategoriesWithLearning） | 对 raw 做商品分类（规则 + classify-item + 学习表）、写回 item.category 等 | OCR、保存、选图、UI |
| **保存**（saveReceipt） | 将 `{ imageUri, analysis }` 写入本地 SQLite（db） | OCR、分类、选图、UI |
| **页面层**（首页） | 选图、权限、确认弹窗、进度、调用 runScanPipeline、根据结果刷新列表、成功/失败 Alert、复活节彩蛋 | 不实现 OCR/分类/保存逻辑，不维护错误码映射表 |

---

## 3. 错误处理方式

### code 从哪里来

- **OCR 阶段**：`lib/ocrService.ts` 在限流、体量过大、网络/服务器错误、响应非法时抛出带 `code` 的错（`RATE_LIMIT` / `PAYLOAD_TOO_LARGE` / `NETWORK_ERROR` / `SERVER_ERROR` / `INVALID_RESPONSE`）。`receiptAnalyzer` 若走 ocrService，这些 code 会透传。
- **Pipeline 捕获**：`runScanPipeline` 的 catch 只认上述 5 个 code；其它错误（含 enrich/save 抛出的）统一归为 `FAILED`。
- **当前**：enrich 或 save 若抛错，若未带 `code`，则返回给调用方的就是 `code: 'FAILED'`。

### 如何映射为用户可见文案

- **统一映射层**：`lib/scanError.ts` 的 `getScanErrorMessage(code)`。
- **映射表**：code → i18n key（`ocr.rateLimit` / `ocr.payloadTooLarge` / `ocr.networkError` / `ocr.serverError` / `ocr.invalidResponse`），未知 code 用 `ocr.failed`。
- **文案来源**：`locales/*.json` 下顶层 `ocr.*`，不再使用已废弃的 `home.scan.rateLimit` 等。

### 单张和多张如何共用

- 单张失败：首页用 `getScanErrorMessage(result.code)` 弹 Alert。
- 多张失败：先 `aggregateBatchScanResults(results)` 得到 `failureReasonsByCode`，再对每个 code 用 `getScanErrorMessage(code)` 得到展示文案，用 `home.scan.failureReasonCount` 拼成「失败原因：A 2 次、B 1 次」等，与单张共用同一套 `ocr.*` 文案。

---

## 4. 多张扫描摘要逻辑

- **聚合**：`lib/scanPipeline.ts` 的 `aggregateBatchScanResults(results)`。遍历每张的 `ScanOneResult`，统计 `successCount`、`failCount`，并按 `code` 聚合到 `failureReasonsByCode`（如 `{ NETWORK_ERROR: 2, RATE_LIMIT: 1 }`）。
- **摘要策略**：  
  - 有失败且存在失败原因时：用 `home.scan.doneSummaryWithReasons`，插值 `ok`、`fail`、`reasons`（reasons 由各 code 的 `getScanErrorMessage` + `failureReasonCount` 拼成，项之间用「、」连接）。  
  - 无失败或未区分原因时：用 `home.scan.doneSummary`，仅「成功 X，失败 Y」。

---

## 5. 已知限制与未来扩展点

- **当前 scanPipeline**：未拆成 ocr-only / enrich-only / save-only 子步骤；如需「只识别不保存」或「只重算分类」需在 pipeline 或上层再封装。
- **send-feedback**：部署状态需人工确认，见 `docs/ENGINEERING.md`。
- **错误结构**：扫描失败统一经 `lib/appError.ts` 的 `toScanAppError(err, stage)` 标准化为 `ScanAppError`（code、message、stage、originalError），再经 `toScanResult()` 转为 pipeline 返回值，便于上报时携带 stage（ocr/enrich/save）。
- **错误上报**：若接入 Sentry/Crashlytics 等，建议在 `lib/appError.ts` 或 `lib/logger.ts` 的 error 入口挂载；扫描链路关键失败已通过 `logger.error('ScanPipeline', ...)` 打点，便于后续对接。
