# 工程说明（环境与后端）

## 环境变量

应用通过 `lib/env.ts` 和 `app.config.js` 的 `extra` 读取配置。优先级：`process.env` → Expo `extra`（来自 .env 在 build 时注入）。

| 变量 | 必填 | 说明 |
|------|------|------|
| `EXPO_PUBLIC_SUPABASE_URL` | 是 | Supabase 项目 URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | 是 | Legacy anon key（eyJ 开头 JWT），用于 Edge Functions |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | 可选 | 与上面二选一或同时存在，会写入 extra |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | 否 | 隐私政策页 URL，缺省用默认 Edge Function |
| `DEV_DIRECT_GEMINI` | 否 | 开发时 `true` 可直连 Gemini，需配 `GEMINI_API_KEY` |
| `GEMINI_API_KEY` | 条件 | 仅当 `DEV_DIRECT_GEMINI=true` 时使用 |
| `EXPO_PUBLIC_SUPPORT_EMAIL` / `SUPPORT_EMAIL` | 否 | 备用反馈邮箱，用于 send-feedback 不可用时提供 mailto 兜底 |

详见 `.env.example`。

## Supabase Edge Functions 现状

| 函数 | 仓库路径 | 用途 | 说明 |
|------|----------|------|------|
| `ocr` | `supabase/functions/ocr/` | 小票 OCR | 主用 |
| `ocr-receipt` | `supabase/functions/ocr-receipt/` | 小票 OCR 备用入口 | 主用 |
| `classify-item` | `supabase/functions/classify-item/` | 商品分类 AI | 主用 |
| `privacy-policy` | `supabase/functions/privacy-policy/` | 返回隐私政策 HTML（Storage） | 主用，verify_jwt=false |
| **send-feedback** | **仓库内无** | 提交用户反馈 | 见下节 |

## send-feedback：调用链、验证与运维

### 调用链

1. **前端入口**：设置 → 发送反馈 → `app/(tabs)/feedback.tsx` 的 `handleSubmit` 调用 `submitFeedback({ message, email })`。
2. **服务层**：`lib/feedbackService.ts` 的 `submitFeedback()` 使用 `getSupabaseUrl()` / `getSupabaseAnonKey()`，请求 `POST {SUPABASE_URL}/functions/v1/send-feedback`，Body 为 JSON（message、email、locale、appVersion、platform、deviceId、receiptId 等），Headers 含 `Authorization: Bearer <anon_key>`、`x-request-id` 等。
3. **成功判定**：仅当 HTTP 2xx、响应体非空、JSON 解析成功且 `response.success === true` 时视为成功；否则抛错，由反馈页 catch 后展示 Alert。

### 如何检查线上是否已部署

- **方式一**：在 Supabase Dashboard → Edge Functions 中查看是否存在 `send-feedback` 且状态为已部署。
- **方式二**：用 curl 或 Postman 发一次请求（需与前端同 URL、同 anon key）：
  ```bash
  curl -X POST "$SUPABASE_URL/functions/v1/send-feedback" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -d '{"message":"test","email":null,"locale":"en"}'
  ```
  - 若返回 404 或 500 且无业务 JSON，多半未部署或部署失败。
  - 若返回 200 且 body 中 `success: true`，可认为主通道可用。
- **本仓库**：无 `supabase/functions/send-feedback` 目录，即不包含该函数源码；可能在其他仓库维护或曾单独部署。

### 本地/测试环境如何判断配置正确

- **必配**：`EXPO_PUBLIC_SUPABASE_URL`、`EXPO_PUBLIC_SUPABASE_ANON_KEY`（或 `SUPABASE_URL` / `SUPABASE_ANON_KEY`）已设置且 anon key 为 JWT（eyJ 开头）。未配置时 `submitFeedback` 会抛「Supabase 未配置」或「Anon key 不是 JWT」。
- **验证**：在反馈页提交一条测试内容；若成功会弹成功 Alert；若失败会在 DEV 下在控制台打出 `[Feedback] status=...`、`[Feedback] Submission failed:` 等，可根据 status 与错误信息判断是未部署、网络还是业务错误。

### 未部署时用户会看到什么

- 提交后请求会失败（如 404/502/超时），`submitFeedback` 抛错，反馈页 catch 后弹出 Alert，标题为「提交失败」类文案，内容为根据 `error.message` 映射的简短说明（网络/服务器/未配置等）。
- 用户输入不会被清空，可重试或走 mailto 兜底（见下）。

### mailto fallback 在什么条件下出现

- **触发条件**：仅在「错误文案为“未配置”类」且 **已配置 support email** 时，Alert 上会多出一个按钮（如「使用邮箱发送」），点击后打开系统邮件客户端，收件人为 support email，主题/正文预填。
- **代码位置**：`app/(tabs)/feedback.tsx` 中 catch 里判断 `errorMessage === t('feedback.error.notConfigured') && supportEmail`，若成立则 Alert 带两按钮，其中一项 `onPress` 调 `openSupportEmail()`。
- 其他错误（网络、服务器、空响应等）只显示单按钮 Alert，不自动提供 mailto；用户仍可在设置/反馈页看到「通过邮箱反馈」的入口（若 UI 有提供）。

### support email 如何配置

- **变量**：`EXPO_PUBLIC_SUPPORT_EMAIL` 或 `SUPPORT_EMAIL`（环境变量或 app.config.js 的 extra）。
- **读取**：`lib/env.ts` 的 `getSupportEmail()`，反馈页用其判断是否有兜底邮箱并打开 mailto。
- 未配置时 `getSupportEmail()` 返回空字符串，mailto 按钮不显示（或入口不可用）。
