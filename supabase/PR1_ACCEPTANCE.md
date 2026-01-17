# PR#1 验收文档 - Production-Grade OCR Edge Function

## 目标与验收标准（DoD）

### ✅ 幂等性（Idempotency）
**验收标准**:
- 同一 `x-idempotency-key` 连续请求 3 次：只有第 1 次触发上游 OCR 调用；后两次直接返回缓存结果
- 并发 10 次同 key：只有 1 次进入上游；其余返回 202 IN_PROGRESS 或直接拿到缓存（取决于时序）

**实现位置**:
- `supabase/functions/ocr/_shared/idempotency.ts` - 幂等表读写、IN_PROGRESS 锁
- `supabase/functions/ocr/index.ts` - 幂等检查流程

**验证步骤**:
```bash
# 1. 第一次请求（触发 OCR）
curl -X POST "https://<project>.supabase.co/functions/v1/ocr" \
  -H "x-device-id: test-device-001" \
  -H "x-idempotency-key: $(echo -n 'test-image' | sha256sum | cut -d' ' -f1)" \
  -H "Authorization: Bearer <anon-key>" \
  -d '{"imageBase64":"...","mimeType":"image/jpeg"}'

# 2. 第二次请求（相同 key，应返回缓存）
# 3. 第三次请求（相同 key，应返回缓存）
# 验证：后两次 latency_ms 显著更低，且日志显示只有 1 次上游调用
```

---

### ✅ 限流（Rate Limiting）
**验收标准**:
- 分钟级超限：返回 HTTP 429，JSON 内 `error.code = RATE_LIMITED`，并带 `retry_after_ms`
- 日级超限：返回 HTTP 429，JSON 内 `error.code = RATE_LIMITED`，并带 `retry_after_ms`

**实现位置**:
- `supabase/functions/ocr/_shared/ratelimit.ts` - 限流检查（分钟/日窗口）
- `supabase/migrations/003_create_ocr_idempotency.sql` - `ocr_ratelimit` 表和 `ocr_ratelimit_incr` RPC

**验证步骤**:
```bash
# 连续请求超过 RATE_LIMIT_PER_MINUTE (默认 6)
for i in {1..8}; do
  curl -X POST "https://<project>.supabase.co/functions/v1/ocr" \
    -H "x-device-id: test-device-ratelimit" \
    -H "x-idempotency-key: $(echo -n "test-$i" | sha256sum | cut -d' ' -f1)" \
    -H "Authorization: Bearer <anon-key>" \
    -d '{"imageBase64":"...","mimeType":"image/jpeg"}'
done

# 验证：至少第 7、8 次返回 429，error.code=RATE_LIMITED，retry_after_ms > 0
```

---

### ✅ 结构化错误（Structured Errors）
**验收标准**:
- 每次失败都返回 `error_code` + `retryable` + `message` + `request_id`
- 错误码符合规范：INVALID_INPUT, RATE_LIMITED, IN_PROGRESS, UPSTREAM_TIMEOUT, UPSTREAM_ERROR, PARSE_ERROR, INTERNAL_ERROR

**实现位置**:
- `supabase/functions/ocr/_shared/response.ts` - 统一响应结构和错误映射

**验证步骤**:
```bash
# 测试各种错误场景
# 1. 缺少 x-idempotency-key -> 400 INVALID_INPUT
# 2. 超限 -> 429 RATE_LIMITED
# 3. 上游超时 -> 504 UPSTREAM_TIMEOUT
# 4. 无效 JSON -> 400 INVALID_INPUT

# 验证：所有错误响应都包含：
# - ok: false
# - request_id: <uuid>
# - idempotency_key: <key>
# - error: { code, message, retryable, ... }
```

---

### ✅ 可观测性（Observability）
**验收标准**:
- 每次请求输出 JSON 日志，包含 `request_id`、耗时、结果状态、`error_code`
- 日志中**不出现**：原始图片、base64、raw_text、商品明细原文

**实现位置**:
- `supabase/functions/ocr/_shared/log.ts` - 统一 JSON 日志（脱敏）

**验证步骤**:
```bash
# 查看 Edge Function 日志
supabase functions logs ocr

# 验证日志格式：
# {"request_id":"...","device_hash_prefix":"abc12345","idempotency_key_prefix":"def67890","status":"success","http_status":200,"latency_ms":1234,"timestamp":"..."}

# 验证：日志中不包含 imageBase64、receipt text、item details
```

---

### ✅ 可测试性（Testability）
**验收标准**:
- 至少 5 个集成测试覆盖：成功/幂等/超限/上游超时/无效输入

**实现位置**:
- `supabase/functions/ocr/tests/ocr.test.ts` - 7 个集成测试

**运行测试**:
```bash
# 设置环境变量
export EDGE_FUNCTION_URL="http://localhost:54321/functions/v1/ocr"
export SUPABASE_ANON_KEY="<anon-key>"
export MOCK_OCR=1  # 使用 mock 模式（不真实调用 Gemini）

# 运行测试
deno test --allow-net --allow-env supabase/functions/ocr/tests/ocr.test.ts
```

**测试用例**:
1. ✅ Test 1: Success response structure
2. ✅ Test 2: Idempotency hit (cached result)
3. ✅ Test 3: Concurrent same key (202 IN_PROGRESS)
4. ✅ Test 4: Rate limit 429
5. ✅ Test 5: Upstream timeout 504
6. ✅ Test 6: Invalid input 400
7. ✅ Test 7: Missing headers 400

---

## 部署步骤

### 1. 运行数据库迁移
```bash
supabase db push
# 或手动执行：
# psql <connection-string> -f supabase/migrations/003_create_ocr_idempotency.sql
```

### 2. 设置环境变量（Supabase Dashboard）
```
GEMINI_API_KEY=<your-key>
SERVER_SALT=<random-salt>
RATE_LIMIT_PER_MINUTE=6
RATE_LIMIT_PER_DAY=60
IDEMPOTENCY_TTL_HOURS=24
IN_PROGRESS_STALE_SECONDS=90
REQUEST_TIMEOUT_MS=25000
```

### 3. 部署 Edge Function
```bash
supabase functions deploy ocr --project-ref <project-ref>
```

### 4. 验证部署
```bash
curl -X POST "https://<project>.supabase.co/functions/v1/ocr" \
  -H "x-device-id: test-device" \
  -H "x-idempotency-key: $(echo -n 'test' | sha256sum | cut -d' ' -f1)" \
  -H "Authorization: Bearer <anon-key>" \
  -d '{"imageBase64":"...","mimeType":"image/jpeg"}'
```

---

## 验收检查清单

### 幂等性
- [ ] 同一 key 连续 3 次请求：只有第 1 次调用上游，后两次返回缓存
- [ ] 并发 10 次同 key：至少 1 个 200，其余 202 或 200（取决于时序）
- [ ] 幂等表记录正确：SUCCEEDED/FAILED 状态，response_json 完整

### 限流
- [ ] 分钟级超限：返回 429，error.code=RATE_LIMITED，retry_after_ms > 0
- [ ] 日级超限：返回 429，error.code=RATE_LIMITED，retry_after_ms > 0
- [ ] 限流表计数正确：`ocr_ratelimit` 表记录正确

### 结构化错误
- [ ] 所有错误响应包含：ok, request_id, idempotency_key, error.code, error.retryable
- [ ] 错误码符合规范：INVALID_INPUT, RATE_LIMITED, IN_PROGRESS, UPSTREAM_TIMEOUT, UPSTREAM_ERROR, PARSE_ERROR, INTERNAL_ERROR
- [ ] HTTP 状态码正确：400/401/429/202/504/502/500

### 可观测性
- [ ] 每次请求输出一行 JSON 日志
- [ ] 日志包含：request_id, device_hash_prefix, idempotency_key_prefix, status, http_status, latency_ms, error_code
- [ ] 日志中**不包含**：imageBase64, raw_text, item details, merchant names

### 可测试性
- [ ] 所有 7 个测试用例通过
- [ ] MOCK_OCR=1 模式下测试可运行（不依赖真实 Gemini API）

---

## 客户端集成注意事项

### 需要更新的客户端代码
1. **生成 idempotency key**: 客户端需要计算图片的 SHA256 作为 `x-idempotency-key`
2. **处理新响应格式**: 响应结构已改变，需要适配新的 `data.receipt` 格式
3. **处理 202 IN_PROGRESS**: 需要实现重试逻辑（等待 `retry_after_ms` 后重试）
4. **处理 429 RATE_LIMITED**: 需要实现退避重试（等待 `retry_after_ms` 后重试）

### 响应格式变化
**旧格式**:
```json
{
  "success": true,
  "analysis": { "merchant": "...", "items": [...] }
}
```

**新格式**:
```json
{
  "ok": true,
  "request_id": "uuid",
  "idempotency_key": "string",
  "data": {
    "receipt": {
      "merchant": { "value": "...", "confidence": 0.9 },
      "items": [{ "name": { "value": "...", "confidence": 0.8 }, ... }]
    }
  }
}
```

---

## 文件清单

### 新增文件
1. `supabase/migrations/003_create_ocr_idempotency.sql` - 数据库迁移
2. `supabase/functions/ocr/index.ts` - 主 Edge Function
3. `supabase/functions/ocr/_shared/log.ts` - 日志模块
4. `supabase/functions/ocr/_shared/response.ts` - 响应结构模块
5. `supabase/functions/ocr/_shared/idempotency.ts` - 幂等模块
6. `supabase/functions/ocr/_shared/ratelimit.ts` - 限流模块
7. `supabase/functions/ocr/tests/ocr.test.ts` - 集成测试

### 保留文件（向后兼容）
- `supabase/functions/ocr-receipt/index.ts` - 旧版 Edge Function（可保留用于迁移期）

---

## 验收通过标准

- ✅ 所有 DoD 项测试通过
- ✅ 幂等性：3 次同 key 请求，只有 1 次上游调用
- ✅ 并发：10 次并发，至少 1 个 200，其余 202/200
- ✅ 限流：超限返回 429，包含 retry_after_ms
- ✅ 错误：所有错误响应结构化，包含 error_code + retryable
- ✅ 日志：JSON 格式，脱敏，无敏感数据
- ✅ 测试：所有 7 个测试用例通过
