# PR#1.2: 安全与一致性修复

## 改动摘要

### A) 锁死 DENO_TESTING 旁路只能在本地环境生效
- ✅ 定义 `IS_LOCAL` 检测（127.0.0.1, localhost, SUPABASE_ENV=local）
- ✅ 只有当 `DENO_TESTING=1` 且 `IS_LOCAL=true` 时才跳过鉴权
- ✅ 非本地环境但 `DENO_TESTING=1` 时返回 500，记录 `MISCONFIGURED_TEST_MODE`

### B) 强化鉴权最小标准
- ✅ Bearer token 路径：必须 `isJwt(token)` 为 true，否则 401
- ✅ apikey 路径：必须匹配环境变量（SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEY / SUPABASE_PUBLISHABLE_ANON_KEY）
- ✅ 删除未使用的函数或真正使用（`isJwt` 和 `parseAuthHeader` 已使用）

### C) 修复 PNG mime_type
- ✅ 修改 `OCRUpstream.call` 签名为 `call(imageBase64: string, mimeType: "image/jpeg"|"image/png")`
- ✅ `index.ts` 调用 `upstream.call(request.imageBase64, request.mimeType)`
- ✅ `DefaultOCRUpstream` 内 `inline_data.mime_type` 使用入参 `mimeType`
- ✅ 更新测试覆盖 PNG（Test 1 使用 `image/png`）

### D) 修复可观测性
- ✅ `createHttpResponse` 增加 `requestId` 参数
- ✅ HTTP 响应头 `x-request-id` 始终设置为当前 `requestId`（即使 body 是缓存的旧 request_id）
- ✅ 所有调用 `createHttpResponse` 的地方都传递 `requestId`

### E) 日志字段严格 8 位
- ✅ 所有 `logRequest`/`logError`/`logSuccess` 传参统一使用 `substring(0, 8)`
- ✅ `device_hash_prefix` / `idempotency_key_prefix` 字段值只允许 8 位
- ✅ `logRequest` 内部使用 `padEnd(8, '0')` 确保严格 8 位

## 风险点

1. **环境检测**: `IS_LOCAL` 检测可能在某些边缘情况下不准确
   - 缓解: 使用多个检测条件（URL 包含 127.0.0.1/localhost 或 SUPABASE_ENV=local）
2. **鉴权增强**: Bearer token 只检查 JWT 格式，不验证签名
   - 缓解: 这是最小标准，生产环境应使用完整的 JWT 验证
3. **apikey 匹配**: 需要确保环境变量正确设置
   - 缓解: 不匹配时返回 401，不会误放行

## 回滚方案

```bash
git revert <commit-hash>
# 或
git checkout PR#1.1 -- supabase/functions/ocr/index.ts
git checkout PR#1.1 -- supabase/functions/ocr/core.ts
git checkout PR#1.1 -- supabase/functions/ocr/_shared/response.ts
git checkout PR#1.1 -- supabase/functions/ocr/_shared/log.ts
```

## 验收测试结果

### 1. Deno 测试全部通过
```bash
DENO_TESTING=1 deno test -A --no-check supabase/functions/ocr/tests/ocr.test.ts
```
**结果**: ✅ `ok | 7 passed | 0 failed`

### 2. PNG mimeType 请求返回 200
```bash
curl -X POST "http://127.0.0.1:54321/functions/v1/ocr" \
  -H "x-device-id: dev-test-png-XXX" \
  -H "x-idempotency-key: XXX" \
  -H "Authorization: Bearer XXX" \
  -d '{"imageBase64":"...","mimeType":"image/png"}'
```
**结果**: ✅ 返回 200，PNG mimeType 正确传递

### 3. DENO_TESTING=1 且非本地 URL 时旁路不生效
```bash
SUPABASE_URL="https://ifgcizhnblkonbjzkfyb.supabase.co" DENO_TESTING=1 deno run ...
```
**结果**: ✅ 返回 500 + `error.code=INTERNAL_ERROR` + `message="Test mode only allowed in local environment"`

## 文件变更

- ✅ `supabase/functions/ocr/index.ts` (鉴权增强、本地环境检测)
- ✅ `supabase/functions/ocr/core.ts` (PNG mimeType 支持、日志 8 位)
- ✅ `supabase/functions/ocr/_shared/response.ts` (requestId header)
- ✅ `supabase/functions/ocr/_shared/log.ts` (严格 8 位 prefix)
- ✅ `supabase/functions/ocr/tests/ocr.test.ts` (PNG 测试用例)
