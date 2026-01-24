修复点：
- `locales/zh.json` 中 `onlyNote` 文案内部引号改为中文引号，避免 JSON 语法错误。
- `app.config.js` 从 `.env` 注入 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`GEMINI_API_KEY` 到 `expo.extra`。

验证：
- `expo start --dev-client --clear` 后真机执行 OCR 扫描
