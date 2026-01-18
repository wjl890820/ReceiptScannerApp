# iOS 公开发布清单

## 1. 版本冻结规则

**发布前冻结期：**
- 仅修复 P0 级别 bug（崩溃、数据丢失、安全漏洞）
- 禁止新增功能
- 禁止重构代码
- 禁止修改依赖版本

**版本号更新位置：**
- `app.json` 第 5 行：`"version": "1.0.0"` → 更新为发布版本（如 `"1.0.0"`）
- `app.json` 第 15 行：`"buildNumber": "1"` → 每次提交 App Store 必须递增（如 `"2"`、`"3"`）
- `app.config.js` 第 23 行：`buildNumber: '1'` → 与 `app.json` 保持一致

**Bundle Identifier：**
- `app.json` 第 14 行：`"bundleIdentifier": "com.receiptscannerapp.app"`（已确认）
- `app.config.js` 第 22 行：`bundleIdentifier: 'com.receiptscannerapp.app'`（已确认）

## 2. 生产 Supabase 核验清单

在发布前，必须验证生产 Supabase 项目配置：

### 环境变量检查
```bash
# 在 Supabase Dashboard > Project Settings > Edge Functions > Secrets 中确认：

✅ MOCK_OCR 不存在或值为 "0"（生产环境禁止 mock）
✅ DENO_TESTING 不存在（生产环境禁止测试旁路）
✅ GEMINI_API_KEY 存在且有效（生产 OCR 必需）
✅ SERVER_SALT 存在且足够随机（设备 ID 哈希盐）
✅ SUPABASE_URL 指向生产环境（非 localhost）
✅ SUPABASE_SERVICE_ROLE_KEY 存在且有效
✅ SUPABASE_ANON_KEY 存在且有效
```

### 限流配置检查
```bash
# 在 Supabase Dashboard > Edge Functions > Environment Variables 中确认：

✅ RATE_LIMIT_PER_MINUTE（默认 6，可根据需要调整）
✅ RATE_LIMIT_PER_DAY（默认 60，可根据需要调整）
✅ REQUEST_TIMEOUT_MS（默认 25000，25 秒）
✅ IDEMPOTENCY_TTL_HOURS（默认 24，幂等缓存 TTL）
✅ IN_PROGRESS_STALE_SECONDS（默认 90，stale 检测）
```

### 数据库表检查
```bash
# 在 Supabase Dashboard > Database > Tables 中确认：

✅ ocr_idempotency 表存在（幂等性记录）
✅ ocr_ratelimit 表存在（限流计数）
✅ ocr_ratelimit_incr RPC 函数存在（限流增量函数）
```

### Edge Function 部署检查
```bash
# 在 Supabase Dashboard > Edge Functions 中确认：

✅ ocr 函数已部署到生产环境
✅ 函数版本与代码仓库一致
✅ 函数日志无异常错误
```

## 3. EAS Secrets 使用要求

**重要：不要依赖本地 `.env` 文件**

### 设置 EAS Secrets
```bash
# 登录 EAS
eas login

# 设置生产环境 secrets（在 EAS Dashboard 或命令行）
eas secret:create --scope project --name GEMINI_API_KEY --value <your-gemini-key>
eas secret:create --scope project --name SUPABASE_URL --value <your-supabase-url>
eas secret:create --scope project --name SUPABASE_ANON_KEY --value <your-anon-key>
```

### 在 app.config.js 中读取
当前 `app.config.js` 第 32 行已配置：
```javascript
extra: {
  ...(config.extra ?? {}),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
}
```

**注意：** EAS Build 会自动注入 secrets 到 `process.env`，无需手动配置。

## 4. EAS Build 命令

### 创建 EAS 配置文件（如果不存在）
```bash
# 如果 eas.json 不存在，运行：
eas build:configure
```

### Production Build
```bash
# iOS Production Build
eas build --platform ios --profile production

# 或指定构建类型
eas build --platform ios --profile production --non-interactive
```

### 构建配置检查
构建前确认：
- ✅ Apple Developer 账号已配置
- ✅ App Store Connect API Key 已配置（如使用）
- ✅ 证书和 Provisioning Profile 有效

## 5. EAS Submit 命令

### 提交到 App Store Connect
```bash
# 提交最新构建到 App Store Connect
eas submit --platform ios --latest

# 或指定构建 ID
eas submit --platform ios --id <build-id>
```

### 提交前检查
- ✅ App Store Connect 中 App 信息已填写完整
- ✅ 隐私政策 URL 已配置
- ✅ 截图已上传（所有必需尺寸）
- ✅ 应用描述已填写（见 `APP_STORE_SUBMISSION.md`）

## 6. App Store Connect 必填项清单

### 基本信息
- ✅ App 名称：Receipt Scanner（或你的最终名称）
- ✅ 副标题：简短描述（可选）
- ✅ 分类：Productivity / Finance（根据实际选择）
- ✅ 内容版权：你的版权信息

### 隐私与合规
- ✅ **隐私政策 URL**：必须提供（见 `PRIVACY_POLICY.md` 或部署到网站）
- ✅ 数据收集声明：如实填写（见 `APP_STORE_SUBMISSION.md`）
- ✅ 出口合规：如使用加密，需填写相应信息

### 应用截图
- ✅ iPhone 6.7"（必需）
- ✅ iPhone 6.5"（必需）
- ✅ iPhone 5.5"（必需）
- ✅ iPad Pro 12.9"（如支持 iPad）

### 应用描述
- ✅ 简短描述（30 字符）
- ✅ 完整描述（4000 字符，见 `APP_STORE_SUBMISSION.md`）
- ✅ 关键词（100 字符）
- ✅ 宣传文本（170 字符，可选）

### 权限说明
- ✅ 相机权限：用于拍摄收据照片
- ✅ 照片库权限：用于选择已有收据照片
- ✅ 网络权限：用于上传图片到 OCR 服务

### 审核备注（如需要）
- ✅ 测试账号（如需要登录）
- ✅ 测试步骤说明
- ✅ OCR/AI 功能说明（见 `APP_STORE_SUBMISSION.md`）

## 7. 发布策略

### Phased Release（推荐）
- ✅ 启用分阶段发布（Phased Release）
- ✅ 初始发布 1% 用户
- ✅ 24 小时后评估，如无问题逐步扩大
- ✅ 7 天内达到 100%

### 监控指标
- 崩溃率（目标 < 1%）
- 网络错误率（目标 < 5%）
- OCR 成功率（目标 > 90%）
- 用户反馈（App Store 评论）

## 8. 监控与紧急止血

### 实时监控
```bash
# Supabase Dashboard > Edge Functions > Logs
# 监控以下指标：
- 错误率（4xx/5xx 响应
- 限流触发频率（429 响应）
- 超时频率（504 响应）
- 平均响应时间
```

### 紧急止血措施

**1. 限流调低（快速降低负载）**
```bash
# 在 Supabase Dashboard > Edge Functions > Environment Variables
# 临时修改：
RATE_LIMIT_PER_MINUTE=2  # 从 6 降到 2
RATE_LIMIT_PER_DAY=20    # 从 60 降到 20
```

**2. 临时返回友好错误（避免崩溃）**
```bash
# 在 Edge Function 代码中临时启用降级模式
# 返回友好的错误提示，而非调用上游 OCR
```

**3. 回滚到指定 commit**
```bash
# 如果发布版本有严重问题，回滚代码：
git checkout <PRE_RELEASE_COMMIT> -- supabase/functions/ocr/
# 重新部署 Edge Function
supabase functions deploy ocr
```

**4. App Store 下架（最后手段）**
- 在 App Store Connect 中暂停新用户下载
- 已安装用户不受影响
- 修复后重新提交审核

## 9. 回滚方案

### 代码回滚
```bash
# 回滚到发布前的 commit
git log --oneline | head -10  # 找到发布前的 commit hash
git checkout <PRE_RELEASE_COMMIT> -- supabase/functions/ocr/
git commit -m "hotfix: rollback to pre-release version"
supabase functions deploy ocr
```

### App Store 回滚
- 在 App Store Connect 中下架当前版本
- 修复问题后重新提交审核
- 或提交修复版本（buildNumber 递增）

### 数据清理（如需要）
```sql
-- 在 Supabase Dashboard > SQL Editor 中执行（谨慎操作）
-- 清理幂等性缓存（如需要）
TRUNCATE TABLE ocr_idempotency;

-- 清理限流计数（如需要）
TRUNCATE TABLE ocr_ratelimit;
```

## 10. 发布后检查清单

### 24 小时内
- ✅ 检查崩溃报告（App Store Connect > Analytics）
- ✅ 检查用户评论（App Store Connect > Reviews）
- ✅ 检查 Supabase 日志（错误率、响应时间）
- ✅ 检查 OCR 成功率（通过日志分析）

### 7 天内
- ✅ 评估分阶段发布效果
- ✅ 收集用户反馈
- ✅ 分析使用数据
- ✅ 准备修复版本（如需要）

## 附录：配置文件位置

- **版本号**：`app.json` 第 5 行
- **Build Number**：`app.json` 第 15 行，`app.config.js` 第 23 行
- **Bundle Identifier**：`app.json` 第 14 行，`app.config.js` 第 22 行
- **EAS 配置**：`eas.json`（如存在）或通过 `eas build:configure` 创建
### 配置文件检查结果

**app.json 位置：** `app.json`

**app.config.js 位置：** `app.config.js`

**eas.json 状态：** 不存在（需要运行 eas build:configure 创建）

**当前配置值：**
- Version: portrait
- iOS Build Number:     },
- Bundle Identifier: 1

**需要修改的位置：**
1. `app.json` 第 5 行：`"version": "1.0.0"` → 更新为发布版本
2. `app.json` 第 15 行：`"buildNumber": "1"` → 每次提交递增
3. `app.config.js` 第 23 行：`buildNumber: '1'` → 与 app.json 保持一致
