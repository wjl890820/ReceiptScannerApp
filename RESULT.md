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

SQLite 数据库修复（item_category_mapping 表）：
- **问题**：iOS dev build 运行时错误 "no such table: item_category_mapping"
- **原因**：`item_category_mapping` 表在 `lib/categoryLearner.ts` 中被使用，但从未在数据库初始化中创建
- **修复**：
  - 在 `lib/db.ts` 的 `initIfNeeded()` 中添加了 `item_category_mapping` 表的创建语句
  - 表结构：`normalized_name` (TEXT PRIMARY KEY), `category` (TEXT NOT NULL), `updated_at` (INTEGER NOT NULL)
  - 添加了索引 `idx_item_category_mapping_updated_at` 用于按更新时间排序
  - 修改 `lib/categoryLearner.ts` 确保在查询前调用 `initIfNeeded()` 初始化数据库
  - 导出 `initIfNeeded` 函数供其他模块使用
  - 添加开发模式自动重置：如果迁移失败（schema 不兼容），自动删除表并重新创建
- **验证步骤**：
  1. 重现问题（修复前）：
     - 在 iOS dev build 中扫描一张小票
     - 应该看到错误："no such table: item_category_mapping"
  2. 验证修复（修复后）：
     - 无需重新安装应用（数据库会自动迁移）
     - 启动应用并扫描一张小票
     - 应该成功完成，不再出现表不存在的错误
     - 编辑商品分类后，应该能正确学习并应用到后续扫描
  3. 开发模式重置测试（可选）：
     - 如果遇到 schema 错误，开发模式下会自动重置数据库
     - 检查控制台日志，应该看到 "[DB] Migration failed, attempting to reset database in dev mode"
     - 然后看到 "[DB] Retrying initialization after reset..."

环境变量读取统一化修复：
- **问题**：运行时日志显示 extra 有正确值，OCR 工作正常，但持续出现误导性警告：
  - "[OCR] Network probe failed"
  - "Ping failed: Supabase URL 未配置"
- **原因**：
  - 多个文件重复实现读取 Expo extra 的逻辑
  - probe/ping 函数在配置存在但网络失败时错误地报告为"未配置"
  - 每次扫描都打印警告，造成日志污染
- **修复**：
  - 创建 `lib/env.ts` 统一读取 Expo extra：
    - `getExtra()`: 统一读取 extra，支持 `expoConfig.extra`、`manifest.extra`、`manifest2.extra` 回退
    - `getSupabaseUrl()`: 获取 Supabase URL
    - `getSupabaseAnonKey()`: 获取 Supabase Anon Key
    - `isDevDirectGeminiEnabled()`: 检查 DEV_DIRECT_GEMINI 开关
    - `getGeminiApiKey()`: 获取 Gemini API Key（仅在开发模式且开关启用时）
  - 更新所有文件使用统一的 env helper：
    - `lib/receiptAnalyzer.ts`: 移除重复的读取逻辑，使用 `getSupabaseUrl()`, `getSupabaseAnonKey()`, `getGeminiApiKey()`, `isDevDirectGeminiEnabled()`
    - `lib/ocrService.ts`: 移除重复的读取逻辑，修复 probe/ping 逻辑
    - `lib/feedbackService.ts`: 移除重复的读取逻辑
  - 修复 probe/ping 逻辑：
    - `probeSupabaseNetwork()`: 仅在配置缺失时返回错误，网络失败时报告为网络错误（包含状态码）
    - `pingOcrEdge()`: 不再抛出错误，返回状态码和错误信息；仅在配置缺失时返回错误，网络失败时报告为网络错误
    - 添加会话级别的日志去重：每个警告只打印一次，避免日志污染
  - 更新 `app/(tabs)/index.tsx`: 移除误导性的警告日志，错误已在内部处理
- **验证步骤**：
  1. 启动应用并扫描一张小票
  2. 检查控制台日志：
     - 应该看到 `[ENV]` 调试日志（显示 extra 有值）
     - 不应该看到重复的 "[OCR] Network probe failed" 或 "Ping failed: Supabase URL 未配置"
     - 如果网络失败，应该看到一次性的网络错误日志（包含状态码）
  3. 验证 OCR 功能正常：
     - 扫描应该成功完成
     - 如果配置正确但网络失败，应该看到明确的网络错误信息，而不是"未配置"错误
