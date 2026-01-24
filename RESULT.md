修复点：
- `locales/zh.json` 中 `onlyNote` 文案内部引号改为中文引号，避免 JSON 语法错误。
- `app.config.js` 从 `.env` 注入 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 到 `expo.extra`（已移除 `GEMINI_API_KEY`）。

OCR 架构变更：
- 客户端不再要求/读取 `GEMINI_API_KEY`，App 端不再把 Gemini key 注入到 Expo extra。
- 默认 OCR 路径改为调用 Supabase Edge Function（优先 `ocr-receipt`，失败 404 再回退到 `ocr`）。
- 仅使用 `SUPABASE_URL` / `SUPABASE_ANON_KEY`（以及现有的 `x-device-id` 方案）。
- 保留一个"仅开发调试"的直连 Gemini fallback：
  - 默认关闭（`DEV_DIRECT_GEMINI=false`）
  - 只能在 `__DEV__` 且显式开关为 `true` 时启用
  - fallback 关闭时，不允许因为缺 `GEMINI_API_KEY` 直接 throw；应走 Edge Function 或给出明确错误。

验证：
- `expo start --dev-client --clear` 后真机执行 OCR 扫描
- 确认不再出现 Gemini key 未配置错误，而是成功调用 Edge Function
- 确认客户端无 Gemini key（检查 app.config.js 和 expo.extra）

环境变量注入修复：
- `app.config.js` 使用 `require('dotenv').config()` 确保环境变量加载
- `extra` 字段正确合并，保留原有字段（router、eas 等）
- `lib/receiptAnalyzer.ts` 中添加了临时调试日志（`[ENV]` 开头）用于验证注入
- **验证通过后可移除日志**：删除 `lib/receiptAnalyzer.ts` 中 `analyzeReceiptImageViaEdgeFunction` 函数开头的三行 console.log
