# 第二阶段工程摘要

基于当前代码事实整理，供后续开发与发布前整理使用。重点回答：现在项目已经整理到什么程度、关键边界在哪、还没做啥、下一步从哪接。

---

## 1. 已完成的结构性改动

- **扫描主链路抽离**：`lib/scanPipeline.ts` 暴露 `runScanPipeline(uri)`，首页只负责选图、权限、进度与结果 Alert，不再内联 OCR/enrich/save。错误通过 `lib/scanError.ts` 的 `getScanErrorMessage(code)` 映射为文案。
- **统一错误与日志**：`lib/appError.ts` 定义可抛出的业务错误；`lib/logger.ts` 提供统一日志入口（当前主要用于扫描/OCR 相关打点和调试）。
- **分析页数据与容错**：`lib/analysisHelpers.ts` 中的 `buildStatsSafe`、`buildPriceRadarData`、`buildCategoryIndexData` 与 `lib/buildInsights.ts`、`lib/statsCalculator.ts`、`lib/priceRadar.ts` 一起负责分析所需数据准备与降级；分析页 `app/(tabs)/analysis.tsx` 只调用 `listReceipts()` + 这些 helper，并在 useMemo 中处理异常，避免 UI 崩溃。
- **历史列表查询能力**：`lib/db.ts` 的 `listReceiptsForList(options?: ListReceiptsOptions | number)` 支持 `limit`、`offset`、`sortBy: 'date' | 'total'`；参数归一化逻辑抽到 `lib/receiptListQuery.ts` 的 `listReceiptsForListParams`，并有 `lib/receiptListQuery.test.ts` 覆盖，避免在测试中直接触及 `expo-sqlite`。
- **首页彩蛋触发收口**：`lib/homeEasterEggHelpers.ts` 提供 `tryShowNextEasterEgg(receiptCount, allReceipts, locale)`，负责选择下一个未展示的里程碑并标记已展示；首页只调用该 helper 并根据返回内容弹 Alert，避免在页面里维护里程碑循环与 hasShown/markShown 细节。
- **首页 KPI / 分类汇总收口**：`lib/homeMetricsHelpers.ts` 提供 `aggregateCategoryData` 与 `computeUncategorizedSummary`（含 `CategoryData` 类型），首页只负责传入过滤后的 receipts 并消费结果；对应的 `lib/homeMetricsHelpers.test.ts` 覆盖空输入/单条聚合/未分类统计等基础情况。
- **首页洞察规则集中**（进行中，已初步成型）：洞察 context 与规则仍定义在首页文件中，但已围绕 `computeInsightContext`、`INSIGHT_RULES` 和 `generateStructuredInsight` 形成清晰边界，后续可以按本轮要求继续收口到 `lib/homeInsightHelpers.ts`。
- **反馈主通道与 mailto 兜底**：`lib/feedbackService.ts` 负责调用 Supabase Edge Function `send-feedback`，做严格的 2xx + body + JSON + `success === true` 判定，并在 __DEV__ 下打印 `status` 与 `requestId` 等可观测信息；`app/(tabs)/feedback.tsx` 在失败时根据错误信息映射为 i18n 文案，并在「未配置且存在 support email」时提供 `mailto` 兜底按钮。
- **历史/反馈/环境文档**：`docs/HISTORY_QUERY.md` 说明历史查询入口和已支持的查询参数；`docs/ENGINEERING.md` 补充 send-feedback 的调用链、部署与验证方法，以及 support email 的配置方式。
- **测试补强**：现有 Jest 单测覆盖扫描管道（`lib/scanPipeline.test.ts`）、分析 helper（`lib/analysisHelpers.test.ts`）、历史列表辅助（`lib/receiptListHelpers.test.ts`）、彩蛋触发入口（`lib/homeEasterEggHelpers.test.ts`）、历史查询参数构建（`lib/receiptListQuery.test.ts`）、首页 KPI/分类计算（`lib/homeMetricsHelpers.test.ts`）。
- **CI 接入**：`.github/workflows/test.yml` 使用 Node 20 + `npm ci` + `npm run test`，在 push/PR 到 main/master/changes 时自动跑 Jest 单测，保证基础逻辑不被悄悄破坏。

---

## 2. 当前已形成的关键工程边界

- **首页（Home）**：专注于编排与展示：选图、权限请求、调用 `runScanPipeline`、刷新本地列表、弹出成功/失败/彩蛋 Alert、渲染 KPI/KPI 卡片、饼图与洞察区块。OCR、分类增强、保存等数据写入逻辑都在 `lib` 层；彩蛋触发决策在 `homeEasterEggHelpers.tryShowNextEasterEgg` 中；KPI/分类/未分类等数据由 `homeMetricsHelpers` 提供；首页只组合这些结果和 UI。
- **分析页（Analysis）**：数据加载入口为页面内 `loadReceipts()` → `listReceipts()`；数据加工入口为 `lib/analysisHelpers` + `buildInsights` + `statsCalculator` + `priceRadar`，页面不直接处理原始 JSON，仅消费处理好的结构（包括价格雷达、分类指数、统计卡片等）。
- **历史页（History）**：加载入口为 `app/(tabs)/history/index.tsx` 中的 `load()` → `listReceiptsForList({ limit: 200 })`；底层 `listReceiptsForList` 已支持 `limit`、`offset`、`sortBy`，并为 `searchQuery` 预留参数；排序与分页逻辑集中在 DB/query 层，页面只关心 rows 与刷新函数。
- **反馈**：主通道依赖 Supabase Edge Function `send-feedback`；若环境未配置或调用失败，前端通过错误信息映射为用户可读文案，并在「配置了 support email 且错误属于未配置/环境问题」时展示 mailto 兜底按钮。环境变量解析集中在 `lib/env.ts`，不会在页面层直接拼接 URL 或密钥。
- **Pro**：`app/(tabs)/pro-insight.tsx` 目前仅为占位文案，无订阅、支付或权限控制逻辑；不会影响现有功能链路。
- **测试与 CI**：所有现有 Jest 测试都是无网络、无数据库 schema 假设的纯逻辑单测（除使用 `expo-sqlite` 的模块外，通过像 `receiptListQuery` 这类 helper 抽象来规避直连），由 GitHub Actions 在每次 push/PR 自动执行。

---

## 3. 当前仍未完成 / 未正式进入的内容

- **历史搜索与完整分页 UI**：底层 `listReceiptsForList` 已支持 `limit`/`offset`/`sortBy`，并在类型上预留 `searchQuery`；但 History 页面尚未提供搜索框、分页控件或排序 UI，`searchQuery` 也还未真正参与 SQL WHERE 条件（将在后续任务中落实）。
- **send-feedback 函数实现与部署状态**：本仓库不包含 `supabase/functions/send-feedback` 源码，实际是否在 Supabase 项目中部署需人工确认；当前前端逻辑兼容「已部署」和「未部署」两种情况，但没有自动探活机制。
- **Pro 功能**：仅存在占位页面与说明文案，无具体收费模型/权限控制/额外功能；是否进入实现阶段取决于后续产品决策。
- **统一观测/埋点体系**：除 scanning/OCR 和 feedback 的少量日志外，没有统一的 error/reporting 埋点方案；如果未来需要线上观测，还需引入专门的 SDK 或自建上报通道。

---

## 4. 下一阶段最自然的切入点

1. **历史搜索与排序 UI**：基于 `listReceiptsForList(options)` 与 `receiptListQuery`，在 History 页或新的 `useHistoryReceipts(options)` hook 中接入 `searchQuery`/`sortBy`/`offset`，先实现最小的「按商户/备注搜索 + 按时间/金额排序」，再视需要扩展为分页或无限滚动。
2. **首页洞察逻辑收口与扩展**：将 `computeInsightContext`、`INSIGHT_RULES` 等从首页迁移到 `lib/homeInsightHelpers.ts`，并补充最小单测，然后视真实数据反馈再迭代规则（阈值、文案选择、规则优先级等），保持首页以 orchestrator 为主。
3. **send-feedback 函数落地与文档闭环**：在 Supabase 项目中补齐/确认 `send-feedback` 实现和部署，将实际部署状态与期望的请求/响应格式写回 `docs/ENGINEERING.md`，必要时补充简单回归脚本（curl 示例或小工具）。
4. **历史 hook 抽象**：在 `hooks` 目录下新增 `useHistoryReceipts(options)`，封装 `listReceiptsForList` 加载/刷新/错误状态，History 页只消费该 hook，未来搜索/分页/筛选的改动都集中在 hook 和 DB/query 层。
5. **Pro 能力探索（可选）**：若产品层面决定推进 Pro，可从现有分析/价格雷达/历史数据出发，设计「额外洞察或提醒」作为增值内容，并在代码层预留 feature flag 或 entitlement 检查。
6. **测试覆盖补强**：在不增加复杂集成环境的前提下，继续优先为 lib/helper/hook 类纯函数补单测（例如即将抽离的 home insight helpers 与历史搜索 helper），确保第三阶段功能开发建立在可回归的基线上。

---

以上为第二阶段的工程层面成果与边界总结，后续第三阶段功能开发可直接以此为基线继续推进。
