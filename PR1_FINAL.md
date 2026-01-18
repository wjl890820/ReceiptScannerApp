# PR#1: OCR Edge Function 生产级实现

## 本次范围

OCR Edge Function 生产级功能实现，包括：

- ✅ **幂等性处理**：基于 `x-idempotency-key` 的请求去重与缓存
- ✅ **限流保护**：分钟级（6次/分钟）和天级（60次/天）限流
- ✅ **日志脱敏**：设备 ID 和幂等键仅记录 8 位前缀
- ✅ **PNG 支持**：支持 `image/jpeg` 和 `image/png` 两种 MIME 类型
- ✅ **测试支持**：本地测试模式（`DENO_TESTING=1`）和 mock OCR（`MOCK_OCR=1`）

## 验证方式

### 自动化验证脚本
```bash
./scripts/verify_ocr_edge.sh
```

包含：
1. `deno check` - TypeScript 类型检查
2. `deno lint` - 代码规范检查
3. `deno test` - 单元测试（7 个用例）

### 黑盒验证（curl）

**1. 成功请求（200）**
```bash
curl -X POST http://127.0.0.1:54321/functions/v1/ocr \
  -H "content-type: application/json" \
  -H "x-device-id: test-device-001" \
  -H "x-idempotency-key: $(openssl rand -hex 32)" \
  -d '{"imageBase64":"...","mimeType":"image/png"}'
```

**2. 幂等性验证（重复请求返回缓存）**
```bash
# 第一次请求
IDEM_KEY="$(openssl rand -hex 32)"
curl -X POST ... -H "x-idempotency-key: $IDEM_KEY" -d '...'

# 第二次相同 key 请求应返回缓存（相同 response_json）
curl -X POST ... -H "x-idempotency-key: $IDEM_KEY" -d '...'
```

**3. 限流验证（429）**
```bash
# 快速请求超过 6 次/分钟阈值
for i in {1..10}; do
  curl -X POST ... -H "x-device-id: same-device" -H "x-idempotency-key: key-$i" -d '...'
done
# 第 7 次开始应返回 429 + RATE_LIMITED
```

## 风险与回滚

### 影响范围
- **仅涉及**：`supabase/functions/ocr/` 目录
- **不影响**：主应用代码（`app/`、`lib/` 等）

### 回滚方案
```bash
# 回滚到 PR#1 之前的状态
git revert <PR1_FINAL_COMMIT>
# 或
git checkout <PRE_PR1_COMMIT> -- supabase/functions/ocr/
```

### 风险点
- 幂等性缓存可能导致旧数据返回（TTL: 24 小时）
- 限流阈值可能影响高频用户（可通过环境变量调整）

## 已知限制

1. **Mock OCR**：仅用于本地测试，生产环境需配置 `GEMINI_API_KEY`
2. **测试旁路**：`DENO_TESTING=1` 仅在 `localhost`/`127.0.0.1` 环境生效，生产环境强制鉴权
3. **类型系统**：Supabase 客户端类型在 Deno 环境下使用 `any`（已添加注释说明）
4. **日志脱敏**：仅记录 8 位前缀，完整哈希不记录

## 相关文件

- 验证脚本：`scripts/verify_ocr_edge.sh`
- 验证输出：`PR1_FINAL_VERIFY.txt`
- 核心逻辑：`supabase/functions/ocr/core.ts`
- HTTP 处理：`supabase/functions/ocr/index.ts`
