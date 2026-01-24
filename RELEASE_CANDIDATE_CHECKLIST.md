# Release Candidate 验收清单

## Commit 1: 稳定性修复 (c8c0005)
**目标**: Analysis 永不崩溃，priceRadar 全链路 null-safety

### ✅ P0-1: Analysis 页面永不崩溃
**测试步骤**:
1. 打开 App → 进入 Analysis 页面
2. 确保有至少 5 张收据（如果没有，先扫描几张）
3. 快速切换时间范围（Week/Month/All）
4. 观察控制台日志，确认无崩溃

**验收标准**:
- ✅ Analysis 页面正常加载，无白屏/崩溃
- ✅ 即使数据异常（如 malformed JSON），也显示"无数据"而不是崩溃
- ✅ 控制台无 `ReferenceError` 或 `TypeError`

**验证命令**:
```bash
# 检查 priceRadar.ts 的 null-safety
grep -n "try {" lib/priceRadar.ts
grep -n "return null\|return \[\]\|return new Map" lib/priceRadar.ts

# 检查 analysis.tsx 的容错
grep -n "try {" app/(tabs)/analysis.tsx
grep -n "return null" app/(tabs)/analysis.tsx
```

---

### ✅ P0-2: 弹窗去重（success/easter egg）
**测试步骤**:
1. 扫描一张新收据
2. 观察是否只显示一次成功提示（或先显示 Easter Egg，然后一次成功提示）
3. 重复扫描，确认每次只显示一次

**验收标准**:
- ✅ 每次扫描完成后，只显示一次成功提示
- ✅ 如果有 Easter Egg，先显示 Easter Egg，然后显示一次成功提示
- ✅ 不会连续弹出多个 Alert

**验证代码位置**:
- `app/(tabs)/index.tsx:850` - `successAlertShownRef` 定义
- `app/(tabs)/index.tsx:1085` - 重置 guard
- `app/(tabs)/index.tsx:1130-1143` - 弹窗逻辑

---

## Commit 2: 产品一致性 (25a97ab)
**目标**: 扫描流程一致、分类系统完善、三语覆盖、隐私合规

### ✅ P0-3: 扫描流程（Camera/Library + Confirm OCR）
**测试步骤**:
1. 点击"扫描小票"按钮
2. 确认弹出选择对话框（拍照/相册/取消）
3. 选择"拍照" → 确认相机权限请求 → 拍照 → 确认 OCR 对话框 → OCR 执行
4. 选择"相册" → 确认相册权限请求 → 选择图片 → 确认 OCR 对话框 → OCR 执行
5. 在确认 OCR 对话框点击"取消"，确认不触发 OCR

**验收标准**:
- ✅ 点击"扫描小票"后，先选择图片来源（拍照/相册）
- ✅ 选择图片后，显示确认 OCR 对话框（包含隐私说明）
- ✅ 只有点击"确认"才执行 OCR
- ✅ 点击"取消"不触发 OCR，直接返回

**验证代码位置**:
- `app/(tabs)/index.tsx:952-963` - 图片来源选择
- `app/(tabs)/index.tsx:997-1012` - 相机流程 + 确认对话框
- `app/(tabs)/index.tsx:1041-1056` - 相册流程 + 确认对话框

---

### ✅ P0-4: 权限处理本地化
**测试步骤**:
1. 拒绝相机权限 → 确认显示本地化错误提示（根据系统语言）
2. 拒绝相册权限 → 确认显示本地化错误提示（根据系统语言）
3. 切换系统语言（zh/ja/en），重复测试

**验收标准**:
- ✅ 权限被拒绝时，显示对应语言的错误提示
- ✅ 中文系统显示中文提示
- ✅ 日文系统显示日文提示
- ✅ 英文系统显示英文提示

**验证代码位置**:
- `app/(tabs)/index.tsx:974` - 相机权限错误
- `app/(tabs)/index.tsx:1019` - 相册权限错误
- `locales/*.json` - `permissions.cameraDeniedTitle/Message`, `permissions.libraryDeniedTitle/Message`

---

### ✅ P0-5: 分类系统（16 个分类，仅超市启用）
**测试步骤**:
1. 扫描超市收据（如"イオン"、"マックスバリュ"）
2. 进入详情页，查看商品分类
3. 编辑商品分类，确认有 16 个分类选项
4. 扫描非超市收据（如"スターバックス"）
5. 进入 Analysis 页面，确认分类统计只显示超市收据

**验收标准**:
- ✅ 超市收据的商品有分类（16 个分类之一）
- ✅ 非超市收据的商品分类为 `non_grocery` 或 `uncategorized`
- ✅ Analysis 页面的分类统计只包含超市收据
- ✅ 分类选项包含：produce, meat_seafood, dairy_eggs, bakery, staples, snacks_sweets, quick_meals, condiments, non_alcoholic_drinks, alcohol, household, frozen_foods, canned_preserved, beverages_other, health_supplements, other_grocery

**验证代码位置**:
- `lib/categories.ts` - 16 个分类定义
- `lib/groceryDetector.ts` - 超市检测逻辑
- `lib/receiptEnricher.ts` - 分类应用逻辑
- `app/(tabs)/history/[id].tsx:122` - 分类编辑选项

---

### ✅ P0-6: 三语覆盖（Tab、扫描弹窗、分类编辑）
**测试步骤**:
1. 系统语言设为中文 → 重启 App → 检查：
   - 底部 Tab 显示中文（首页/历史/设置/分析）
   - 扫描对话框显示中文
   - 分类标签显示中文
2. 系统语言设为日文 → 重启 App → 检查：
   - 底部 Tab 显示日文（ホーム/履歴/設定/分析）
   - 扫描对话框显示日文
   - 分类标签显示日文
3. 系统语言设为英文 → 重启 App → 检查：
   - 底部 Tab 显示英文（Home/History/Settings/Analysis）
   - 扫描对话框显示英文
   - 分类标签显示英文

**验收标准**:
- ✅ Tab 标签跟随系统语言（zh/ja/en）
- ✅ 扫描流程所有对话框跟随系统语言
- ✅ 分类标签跟随系统语言
- ✅ 分类编辑弹窗跟随系统语言

**验证代码位置**:
- `app/(tabs)/_layout.tsx` - Tab 标签使用 `t('tabs.*')`
- `locales/en.json`, `locales/zh.json`, `locales/ja.json` - `tabs.*`, `scan.*`, `category.*` keys

---

### ✅ P0-7: 隐私合规（PRIVACY_POLICY + 设置页入口）
**测试步骤**:
1. 进入设置页面
2. 确认有"隐私政策"入口
3. 点击"隐私政策"，确认显示隐私说明（或打开文件）

**验收标准**:
- ✅ 设置页面有"隐私政策"入口
- ✅ `PRIVACY_POLICY.md` 文件存在，包含英文和日文版本
- ✅ 隐私政策说明：不保存图片、不保存全文、仅记录匿名使用统计

**验证代码位置**:
- `app/(tabs)/settings.tsx` - 隐私政策入口
- `PRIVACY_POLICY.md` - 隐私政策文档
- `locales/*.json` - `settings.privacy.*` keys

---

## 验收截图要求

### 截图 1: Analysis 页面稳定性
- **场景**: 有异常数据的收据（如 malformed JSON）
- **预期**: 显示"无数据"而不是崩溃
- **截图**: Analysis 页面正常显示，价格雷达区域显示"无数据"

### 截图 2: 扫描流程
- **场景**: 点击"扫描小票" → 选择"拍照" → 确认 OCR 对话框
- **预期**: 显示确认对话框，包含隐私说明
- **截图**: 确认 OCR 对话框（包含隐私说明文本）

### 截图 3: 分类系统（16 个分类）
- **场景**: 进入收据详情页 → 编辑商品分类
- **预期**: 显示 16 个分类选项
- **截图**: 分类编辑弹窗，显示所有 16 个分类选项

### 截图 4: 三语覆盖（Tab 标签）
- **场景**: 系统语言切换（zh/ja/en）
- **预期**: Tab 标签跟随系统语言
- **截图**: 三张截图，分别显示中文/日文/英文 Tab 标签

### 截图 5: 隐私政策入口
- **场景**: 进入设置页面
- **预期**: 显示"隐私政策"入口
- **截图**: 设置页面，显示"隐私政策"选项

---

## 验收日志要求

### 日志 1: Analysis 容错测试
```
[Analysis] priceRadarData computation failed: [error message]
[Analysis] categoryIndex computation failed: [error message]
[Analysis] stats computation failed: [error message]
```
**预期**: 有错误日志，但页面不崩溃，显示"无数据"

### 日志 2: priceRadar null-safety
```
[priceRadar] Failed to parse receipt: [receipt_id] [error]
[priceRadar] Failed to process item: [item_name] [error]
[priceRadar] computeCheapestMerchants failed: [error]
```
**预期**: 有警告日志，但函数返回空值而不是 throw

### 日志 3: 扫描流程
```
[ReceiptAnalyzer] Calling Edge Function: ocr-receipt
[OCR] Analyzing receipt image
[OCR] Request sent to Edge Function
[OCR] Response received: success=true
```
**预期**: OCR 流程正常，无网络错误，不再出现 Gemini API Key 相关错误

### ✅ P0-8: OCR 架构验证（客户端无 Gemini Key）
**测试步骤**:
1. 检查 `app.config.js`，确认 `expo.extra` 中不包含 `GEMINI_API_KEY`
2. 检查 `.env` 文件，确认可以不设置 `GEMINI_API_KEY`（或设置但不注入到客户端）
3. 真机扫描一张小票，确认成功调用 Edge Function
4. 检查控制台日志，确认不再出现 "Gemini API Key 未配置" 错误

**验收标准**:
- ✅ `app.config.js` 的 `expo.extra` 中不包含 `GEMINI_API_KEY`
- ✅ 客户端 OCR 通过 Supabase Edge Function 完成（优先 `ocr-receipt`，失败 404 再回退到 `ocr`）
- ✅ 不再出现 "Gemini API Key 未配置" 错误
- ✅ 如果 Edge Function 失败，显示明确的错误信息（function 失败/网络/401/500）

**验证代码位置**:
- `app.config.js` - 确认 `GEMINI_API_KEY` 已移除
- `lib/receiptAnalyzer.ts` - 确认主路径调用 Edge Function
- `lib/receiptAnalyzer.ts` - 确认 DEV_DIRECT_GEMINI fallback 仅在开发模式且显式启用时可用

---

## 快速验证命令

```bash
# 检查 Commit 1 文件
git show c8c0005 --stat

# 检查 Commit 2 文件
git show 25a97ab --stat

# 检查所有修改的文件
git diff HEAD~2 --name-only

# 验证分类数量（应该是 16 个）
grep -A 20 "GROCERY_CATEGORIES" lib/categories.ts | grep -c "'"

# 验证三语覆盖
grep -c "tabs\." locales/en.json locales/zh.json locales/ja.json
grep -c "category\." locales/en.json locales/zh.json locales/ja.json
```

---

## 验收通过标准

- ✅ 所有 P0 项测试通过
- ✅ 无崩溃、无白屏
- ✅ 三语覆盖完整
- ✅ 隐私政策文档存在
- ✅ 所有截图和日志符合要求
