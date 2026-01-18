# PR#1 Final Report (Full)

## 1. Objective

本次 PR 实现了生产级 OCR Edge Function，包含以下核心能力：
- **幂等性处理**：基于 `x-idempotency-key` 的请求去重与结果缓存（24小时 TTL）
- **限流保护**：分钟级（6次/分钟）和天级（60次/天）限流，防止滥用
- **日志脱敏**：设备 ID 和幂等键仅记录 8 位前缀，保护用户隐私
- **PNG 支持**：支持 `image/jpeg` 和 `image/png` 两种 MIME 类型
- **测试支持**：本地测试模式（`DENO_TESTING=1`）和 mock OCR（`MOCK_OCR=1`）用于开发验证

## 2. Deliverables

### Core Implementation
- `supabase/functions/ocr/index.ts` - HTTP 处理层（鉴权、请求解析、上下文组装）
- `supabase/functions/ocr/core.ts` - 核心业务逻辑（幂等、限流、OCR 调用、响应构造）

### Shared Modules
- `supabase/functions/ocr/_shared/idempotency.ts` - 幂等性处理（记录查询、锁获取、结果保存）
- `supabase/functions/ocr/_shared/ratelimit.ts` - 限流检查（分钟/天级窗口）
- `supabase/functions/ocr/_shared/response.ts` - 统一响应结构（成功/错误格式）
- `supabase/functions/ocr/_shared/log.ts` - 日志记录（脱敏、结构化输出）

### Testing & Verification
- `supabase/functions/ocr/tests/ocr.test.ts` - 单元测试（7 个用例：成功、幂等、并发、限流、无效输入、鉴权）
- `scripts/verify_ocr_edge.sh` - 自动化验证脚本（deno check/lint/test）

### Documentation
- `PR1_FINAL.md` / `PR1_FINAL_VERIFY.txt` - PR 说明与验证记录
- `PR1_REPORT_FULL.md` / `PR1_REPORT_PR.md` - 详细报告与 PR 描述

### Editor/Tooling Configuration
- `.vscode/settings.json` - Deno 配置（enablePaths 仅作用于 supabase/functions，全局关闭 TS validate）
- `supabase/functions/tsconfig.json` - 独立 TypeScript 配置（允许 .ts 扩展导入）

## 3. Key Design Decisions

### Authentication
- **Bearer Token 路径**：必须为 JWT 格式（3 段，用 `.` 分隔）
- **API Key 路径**：必须匹配环境变量中的 `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY` 之一
- **测试旁路**：`DENO_TESTING=1` 仅在本地环境（`localhost`/`127.0.0.1`）生效，生产环境强制鉴权
- **安全边界**：若 `DENO_TESTING=1` 但非本地环境，返回 500 + `MISCONFIGURED_TEST_MODE`

### Idempotency
- **状态管理**：`IN_PROGRESS` / `SUCCEEDED` / `FAILED` 三种状态
- **缓存策略**：`SUCCEEDED` 或 `FAILED` 结果缓存 24 小时，相同 key 直接返回缓存
- **并发处理**：`IN_PROGRESS` 状态使用原子更新（`UPDATE ... WHERE status = 'IN_PROGRESS'`）防止竞态
- **Stale 检测**：`IN_PROGRESS` 超过 90 秒视为 stale，允许重试
- **锁获取**：`acquireProcessingLock` 使用 upsert + 原子检查确保只有一个请求处理

### Rate Limiting
- **分钟级限流**：6 次/分钟（`RATE_LIMIT_PER_MINUTE`，可通过环境变量调整）
- **天级限流**：60 次/天（`RATE_LIMIT_PER_DAY`，可通过环境变量调整）
- **返回结构**：429 状态码 + `RATE_LIMITED` 错误码 + `retry_after_ms`（秒级重试时间）
- **实现方式**：使用 Supabase RPC `ocr_ratelimit_incr` 函数，基于时间窗口 bucket 计数

### Privacy & Logging
- **脱敏规则**：设备 ID 和幂等键仅记录 8 位前缀（`substring(0, 8)`）
- **敏感字段排除**：不记录 `raw_text`、`base64`、商品明细等敏感信息
- **结构化日志**：JSON 格式输出，包含 `request_id`、`device_hash_prefix`、`idempotency_key_prefix`、`status`、`http_status`、`latency_ms`、`timestamp`
- **日志级别**：`logRequest`（一般请求）、`logSuccess`（成功）、`logError`（错误）

### PNG Support
- **MIME 类型传递**：`OCRUpstream.call(imageBase64, mimeType)` 签名接受 `'image/jpeg' | 'image/png'`
- **类型规范化**：请求体中的 `mimeType` 通过三元表达式规范化为联合类型（避免 `string` 类型推断）
- **上游传递**：`DefaultOCRUpstream` 将 `mimeType` 传递给 Gemini API 的 `inline_data.mime_type`
- **测试覆盖**：至少一个测试用例使用 `image/png` 验证

### Test Bypass & Mock
- **DENO_TESTING**：仅在本地环境（`SUPABASE_URL` 包含 `127.0.0.1` 或 `localhost`）允许跳过鉴权
- **MOCK_OCR**：返回固定测试数据，用于本地开发验证，不调用真实 Gemini API
- **边界检查**：生产环境强制鉴权，测试旁路不会在生产环境生效

## 4. Verification Matrix

### Automated Verification
运行 `./scripts/verify_ocr_edge.sh` 包含：
1. **deno check** - TypeScript 类型检查（`index.ts`、`core.ts`）
2. **deno lint** - 代码规范检查（`index.ts`、`core.ts`、`_shared/*.ts`）
3. **deno test** - 单元测试（7 个用例，全部通过）

详细输出见：`PR1_REPORT_VERIFY.txt`

### Black-box Verification (curl)
关键验证场景：
1. **200 Success**：正常请求返回成功响应，包含 receipt 数据
2. **200 Idempotency Hit**：相同 `x-idempotency-key` 的第二次请求返回缓存结果（相同 `response_json`）
3. **429 Rate Limited**：快速请求超过阈值后返回 429 + `RATE_LIMITED` + `retry_after_ms`

历史验证输出见：`PR1_FINAL_VERIFY.txt`

## 5. Risks / Limitations

### Editor Diagnostics Trade-off
- **当前方案**：全局关闭 TypeScript 验证（`typescript.validate.enable: false`），Deno 仅作用于 `supabase/functions`
- **影响**：主工程（`app/`、`lib/` 等）在编辑器内不再显示 TS 诊断
- **缓解**：主工程类型检查需通过命令行（`tsc`）或 CI/CD 进行
- **原因**：避免 TS 与 Deno 诊断冲突导致的 ts(2307)/ts(5097) 错误

### Test Bypass Security
- **MOCK_OCR**：仅用于本地测试，生产环境必须配置 `GEMINI_API_KEY`
- **DENO_TESTING**：仅在本地环境生效，生产环境强制鉴权
- **风险**：若生产环境误配置 `DENO_TESTING=1` 且 `SUPABASE_URL` 指向本地，会跳过鉴权（已通过 `IS_LOCAL` 检查缓解）

### Type System Limitations
- **Supabase Client**：在 Deno 环境下类型推断不完整，`_shared/idempotency.ts` 和 `_shared/ratelimit.ts` 使用 `any` 类型（已添加注释说明）
- **影响范围**：仅限 Supabase 客户端调用边界，不影响业务逻辑类型安全

### Idempotency Cache
- **TTL**：24 小时，过期后允许重新处理
- **风险**：若上游数据更新，缓存可能返回旧数据
- **缓解**：客户端可通过不同的 `x-idempotency-key` 强制刷新

## 6. Rollback Plan

### Impact Scope
- **仅影响**：`supabase/functions/ocr/` 目录
- **不影响**：主应用代码（`app/`、`lib/` 等）、数据库结构（幂等/限流表需保留）

### Rollback Commands
```bash
# 方案 1: 回滚 PR#1 的所有提交
git revert <PR1_START_COMMIT>..<PR1_END_COMMIT>

# 方案 2: 重置到 PR#1 之前的状态
git checkout <PRE_PR1_COMMIT> -- supabase/functions/ocr/

# 方案 3: 如果 PR#1 有 tag，直接 checkout
git checkout <PRE_PR1_TAG>
```

### Post-rollback Actions
- 清理 Supabase 数据库中的 `ocr_idempotency` 和 `ocr_ratelimit` 表（如需要）
- 恢复编辑器配置（如需要）

## 7. Next Steps (Not Started)

以下建议不进入 PR#2，仅作为后续优化方向：

1. **CI/CD 集成**：在 CI 中添加 `./scripts/verify_ocr_edge.sh` 作为 PR 检查
2. **主工程 TS 检查**：在 CI 中添加 `tsc --noEmit` 确保主工程类型安全
3. **监控与告警**：集成 Supabase 日志监控，追踪 OCR 调用量、错误率
4. **性能优化**：考虑缓存 Gemini API 响应（在幂等性基础上）
5. **类型系统改进**：探索 Supabase 客户端类型在 Deno 环境下的更好解决方案

## Appendix: Traceability

### Git Info
- Branch: changes
- Timestamp: Sun Jan 18 21:51:50 JST 2026

#### Recent Commits (last 10)
315e86c chore(editor): disable ts validate and rely on deno for supabase functions
01da7d3 chore(editor): disable ts validate for supabase functions and use deno
2f85332 chore(editor): update tsconfig for improved module resolution and .ts file support
37c02b4 chore(editor): isolate supabase functions tsconfig and allow .ts imports
b06e680 docs(ocr): add PR#1 final verification record
aae2ff8 chore(editor): scope deno to supabase functions via enablePaths
fd3faaa chore(ocr): add edge verification script
5551315 chore(editor): configure deno diagnostics for edge functions
99f373f chore(ocr): clean lint issues and tighten types
d6001ac docs: add PR#1 file list and deployment guide

#### Key Files
- `supabase/functions/ocr/index.ts`
- `supabase/functions/ocr/core.ts`
- `supabase/functions/ocr/_shared/idempotency.ts`
- `supabase/functions/ocr/_shared/ratelimit.ts`
- `supabase/functions/ocr/_shared/response.ts`
- `supabase/functions/ocr/_shared/log.ts`
- `supabase/functions/ocr/tests/ocr.test.ts`
- `scripts/verify_ocr_edge.sh`
