# PR#1 文件清单

## 新增文件

### 数据库迁移
1. **supabase/migrations/003_create_ocr_idempotency.sql**
   - `ocr_idempotency` 表：存储幂等响应和 IN_PROGRESS 锁
   - `ocr_ratelimit` 表：窗口计数（分钟/日）
   - `ocr_ratelimit_incr` RPC：原子自增函数
   - `ocr_idempotency_cleanup` RPC：清理过期记录
   - RLS 策略：拒绝客户端访问，仅 service_role

### Edge Function 主入口
2. **supabase/functions/ocr/index.ts**
   - 主处理逻辑
   - 幂等检查 → 限流检查 → 获取处理锁 → 调用 Gemini → 保存结果
   - 结构化错误处理
   - 超时处理（AbortController）
   - 响应格式转换（旧格式 → 新结构化格式）

### 共享模块
3. **supabase/functions/ocr/_shared/log.ts**
   - 统一 JSON 日志输出
   - 脱敏处理（只输出 device_hash 和 idempotency_key 前 8 位）
   - 禁止输出：图片、base64、raw_text、商品明细

4. **supabase/functions/ocr/_shared/response.ts**
   - 统一响应结构定义
   - 错误码映射（ErrorCode → HTTP Status）
   - 创建成功/错误响应的辅助函数
   - HTTP 响应创建（包含 CORS 和 retry-after 头）

5. **supabase/functions/ocr/_shared/idempotency.ts**
   - 幂等 key 验证
   - 幂等记录读取
   - 处理锁获取（原子操作，防止竞态）
   - 结果保存（SUCCEEDED/FAILED）

6. **supabase/functions/ocr/_shared/ratelimit.ts**
   - 分钟/日 bucket 生成
   - 限流检查（调用 RPC 原子自增）
   - 返回限流结果（allowed, count, limit, window, retryAfterMs）

### 测试
7. **supabase/functions/ocr/tests/ocr.test.ts**
   - 7 个集成测试用例
   - 支持 MOCK_OCR 模式（不依赖真实 Gemini API）

### 文档
8. **supabase/PR1_ACCEPTANCE.md**
   - 验收标准
   - 部署步骤
   - 验收检查清单
   - 客户端集成注意事项

---

## 修改的文件

无（新功能，不影响现有 `ocr-receipt` 函数）

---

## 文件统计

```
新增文件: 8
- SQL 迁移: 1
- Edge Function: 1 (主入口)
- 共享模块: 4
- 测试: 1
- 文档: 1

总代码行数: ~1458 行
- index.ts: ~640 行
- 共享模块: ~500 行
- 测试: ~230 行
- 迁移: ~80 行
```

---

## 部署顺序

1. **运行数据库迁移**
   ```bash
   supabase db push
   # 或
   psql <connection> -f supabase/migrations/003_create_ocr_idempotency.sql
   ```

2. **设置环境变量**（Supabase Dashboard → Edge Functions → ocr → Secrets）
   ```
   GEMINI_API_KEY=<your-key>
   SERVER_SALT=<random-salt>
   RATE_LIMIT_PER_MINUTE=6
   RATE_LIMIT_PER_DAY=60
   IDEMPOTENCY_TTL_HOURS=24
   IN_PROGRESS_STALE_SECONDS=90
   REQUEST_TIMEOUT_MS=25000
   ```

3. **部署 Edge Function**
   ```bash
   supabase functions deploy ocr --project-ref <project-ref>
   ```

4. **运行测试**（可选）
   ```bash
   export EDGE_FUNCTION_URL="https://<project>.supabase.co/functions/v1/ocr"
   export SUPABASE_ANON_KEY="<anon-key>"
   export MOCK_OCR=1
   deno test --allow-net --allow-env supabase/functions/ocr/tests/ocr.test.ts
   ```

---

## 验收检查

参考 `supabase/PR1_ACCEPTANCE.md` 进行完整验收。

### 快速验证命令

```bash
# 1. 幂等性测试
IDEMPOTENCY_KEY=$(echo -n 'test-image' | sha256sum | cut -d' ' -f1)
curl -X POST "https://<project>.supabase.co/functions/v1/ocr" \
  -H "x-device-id: test-device" \
  -H "x-idempotency-key: $IDEMPOTENCY_KEY" \
  -H "Authorization: Bearer <anon-key>" \
  -d '{"imageBase64":"...","mimeType":"image/jpeg"}'

# 2. 限流测试
for i in {1..8}; do
  curl -X POST "https://<project>.supabase.co/functions/v1/ocr" \
    -H "x-device-id: test-ratelimit" \
    -H "x-idempotency-key: $(echo -n "test-$i" | sha256sum | cut -d' ' -f1)" \
    -H "Authorization: Bearer <anon-key>" \
    -d '{"imageBase64":"...","mimeType":"image/jpeg"}'
done

# 3. 检查日志（应无敏感数据）
supabase functions logs ocr --tail 20
```
