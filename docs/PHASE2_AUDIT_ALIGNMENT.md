# ReceiptScannerApp — 第二阶段开发前审计与对齐清单

基于当前代码库的真实现状整理，用于第二阶段排期与决策。**未改任何代码，仅分析与清单。**

---

# A. 项目现状总览

1. **技术栈**：Expo SDK 54 + React Native 0.81 + expo-router 文件路由，TypeScript strict，本地 SQLite（expo-sqlite），Supabase 仅用于 Edge Functions（OCR、classify-item、send-feedback、privacy-policy）。
2. **入口与导航**：根布局 `app/_layout.tsx` 只做 i18n 初始化与 Splash；Tab 布局 `app/(tabs)/_layout.tsx` 定义 4 个可见 Tab（首页、分析、历史、设置）+ 3 个隐藏路由（history/[id]、pro-insight、feedback）。
3. **核心业务流程**：拍照/选图 → 压缩 → 调 Edge Function OCR → receiptAnalyzer 拼装分析结果 → receiptEnricher 做分类（规则 + classify-item AI，含学习与限流）→ db.saveReceipt → 首页/历史/分析从 db 读数据展示。
4. **数据层**：单库 `receipts_v2.db`，表 `receipts`（含 transaction_at、user_edited、user_items_json 等）、表 `item_category_mapping`（分类学习）；无服务端用户账号，无云端同步。
5. **API 依赖**：全部为 Supabase Edge Functions（ocr / ocr-receipt、classify-item、send-feedback、privacy-policy）；环境变量通过 app.config.js extra + dotenv 注入，env.ts 统一读取。
6. **i18n**：expo-localization 检测语言，zh/ja/en 三语，locales/*.json + lib/i18n.ts 同步 t()，无运行时切换；硬编码已收敛到 history/feedback 等少数处并已 i18n 化。
7. **首页（index.tsx）**：约 1773 行，承担时间范围、KPI、饼图、扫描入口、多图确认、权限、错误提示、复活节彩蛋、本地 inferCategory+applyLocalCategories 定义（后者未使用，属死代码）。
8. **分析页（analysis.tsx）**：依赖 buildInsights、statsCalculator、priceRadar、categoryIndex；有容错 useMemo 与“仅 grocery”过滤；价格雷达需 ≥5 张 grocery 收据才展示。
9. **历史**：列表 listReceiptsForList 按 transaction_at/created_at 排序，支持批量删除；详情 [id] 可编辑商品数量/小计/分类并写回 user_items_json，分类学习走 receiptEnricher。
10. **设置/反馈/Pro**：设置页为静态入口（反馈、Pro、隐私政策外链、关于）；反馈提交走 send-feedback Edge Function；Pro 为占位文案“即将推出”，无订阅或支付。
11. **鉴权与权限**：无用户登录；仅设备级权限（相机、相册），由 ImagePicker 与 Alert 提示处理；Edge 调用用 anon key，JWT 校验在 env/categoryAiClient/ocrService/feedbackService 中做防御性检查。
12. **构建与发布**：EAS 配置在 eas.json（development/preview/production），appVersionSource 为 remote；曾因缺少 lib/buildInsights 物理文件导致 EAS Bundle 失败，已通过将 buildInsights 落到 lib/buildInsights.ts 修复。
13. **测试**：仅 supabase/functions/ocr/tests/ocr.test.ts 存在；前端与其余 lib 无单测/集成测。
14. **文档与脚本**：README 为 Expo 模板；docs 下有若干回归/验证文档（如 PRIVACY_POLICY_ENCODING_FIX、CLASSIFY_TIMEOUT_FIX_VERIFICATION 等）；scripts 有 fix_privacy_content_type.mjs；tools 有 replay_receipts.js。
15. **依赖**：nanoid 由 db.ts 使用，未在 package.json 的 dependencies 中显式声明，通过某依赖间接安装（存在版本漂移风险）。

---

# B. 模块清单（统一颗粒度）

---

### 1. 应用入口与导航

- **当前状态**：已完成
- **涉及目录或文件**：`app/_layout.tsx`、`app/(tabs)/_layout.tsx`
- **当前实现了什么**：根布局阻塞渲染直至 initI18n；Tab 定义 4 主 Tab + 3 隐藏屏；HapticTab、IconSymbol、主题色；tab 标题走 t() 且 useMemo 延迟避免模块加载时 i18n 未就绪。
- **还缺什么**：深链（deeplink）未在文档或代码中明确；无统一 404/错误边界页。
- **主要问题**：无
- **第二阶段建议动作**：如需 deeplink，在 expo-router 与 scheme 上补文档与简单用例；可选增加全局错误边界。

---

### 2. 首页（Home）

- **当前状态**：部分完成（功能全，可维护性差）
- **涉及目录或文件**：`app/(tabs)/index.tsx`
- **当前实现了什么**：时间范围（7D/30D/ALL）持久化、收据列表过滤、KPI（总支出/主要类别/非必需品）、饼图、扫描单张/多张、图片来源选择、权限被拒提示、确认弹窗（含隐私说明）、OCR 错误映射、成功/失败 Alert、复活节彩蛋（3/5/7/10 张）、空状态；与 receiptAnalyzer、receiptEnricher、db、settingsStore、easterEggs、categoryPalette 等强耦合。
- **还缺什么**：无下拉刷新入口（列表依赖 focus 重载）；扫描进度在批量时已有，单张无进度条。
- **主要问题**：文件过大（约 1773 行）；内含未使用的 `inferCategory` + `applyLocalCategories`（约百行死代码）；饼图/KPI/扫描流程/复活节彩蛋均在同一文件，难以单测与复用。
- **第二阶段建议动作**：删除死代码；将“扫描流程”（选图→OCR→enrich→save→反馈）抽到 hook 或 lib；饼图与 KPI 区块可拆成纯展示组件并收口数据来自 props。

---

### 3. 分析页（Analysis）

- **当前状态**：已完成
- **涉及目录或文件**：`app/(tabs)/analysis.tsx`、`lib/buildInsights.ts`、`lib/statsCalculator.ts`、`lib/priceRadar.ts`、`lib/productNormalizer.ts`
- **当前实现了什么**：时间范围（周/月/全部）、统计卡片（总支出、生鲜、主要类别、商家、最高单笔）、分析 V2（story/changes/tips/confidence）、价格雷达（≥5 张 grocery）、分类价格指数、Pro  teaser 弹窗、grocery 过滤与 uncategorized 提示；全链路 try/catch 降级，避免崩溃。
- **还缺什么**：无导出/分享；Pro 仅文案无实际能力。
- **主要问题**：单文件仍较长（约 613 行）；与 buildInsights、priceRadar、statsCalculator 耦合正常，但 UI 与数据可再分离以便测试。
- **第二阶段建议动作**：若扩展分析维度，优先把“数据准备”放到 lib 或 hook，页面只做展示与交互；Pro 是否实现需产品确认。

---

### 4. 历史列表与详情

- **当前状态**：已完成
- **涉及目录或文件**：`app/(tabs)/history/index.tsx`、`app/(tabs)/history/[id].tsx`、`lib/db.ts`
- **当前实现了什么**：列表按 transaction_at/created_at 排序、下拉刷新、批量选择与删除、确认与错误 i18n；详情展示商户/日期/总额/分类汇总/商品明细、编辑单条（数量/小计/分类）、学习写入 categoryLearner、删除单条；图片不展示（隐私已移除）。
- **还缺什么**：列表无分页（listReceiptsForList(200) 上限）；详情无分享/导出。
- **主要问题**：详情页仍有少量可 i18n 的文案（如“未找到该记录”“分类汇总”等，需确认是否已全部进 locales）；编辑 Modal 与主屏同文件，可拆组件。
- **第二阶段建议动作**：将未 i18n 的详情文案收进 locales；若历史量增大，考虑分页或虚拟列表；编辑弹窗可抽成独立组件便于复用与测试。

---

### 5. 设置、反馈与 Pro 占位

- **当前状态**：设置与反馈已完成；Pro 为占位
- **涉及目录或文件**：`app/(tabs)/settings.tsx`、`app/(tabs)/feedback.tsx`、`app/(tabs)/pro-insight.tsx`、`lib/feedbackService.ts`、`constants/privacy.ts`
- **当前实现了什么**：设置提供反馈、Pro、隐私政策（外链 Edge Function URL）、关于（版本从 Constants 取）；反馈表单提交到 send-feedback，错误类型映射与 i18n；Pro 为静态功能列表与 footer 文案。
- **还缺什么**：Pro 无订阅/支付/权益逻辑；无“清除缓存”或“导出数据”等高级设置。
- **主要问题**：无
- **第二阶段建议动作**：若做 Pro，需单独排期（计费、权益控制、前端开关）；否则保持占位即可。

---

### 6. OCR 与收据分析管道

- **当前状态**：已完成
- **涉及目录或文件**：`lib/ocrService.ts`、`lib/receiptAnalyzer.ts`、`lib/dateParser.ts`、Supabase `ocr`、`ocr-receipt`
- **当前实现了什么**：图片压缩、base64 上传、Edge 调用（ocr 或 ocr-receipt）、transactionDate 抽取与解析（含日文格式）、DEV 直连 Gemini 可选；错误码 RATE_LIMIT/PAYLOAD_TOO_LARGE/NETWORK/SERVER 等映射。
- **还缺什么**：离线或弱网下的明确降级策略（仅提示重试）；日文日期格式覆盖是否完整需依赖真实小票样本验证。
- **主要问题**：receiptAnalyzer 与 ocrService 均有压缩逻辑，存在重复；env 与 JWT 校验已做，但错误文案依赖 i18n 与 ocrService 返回一致。
- **第二阶段建议动作**：统一压缩入口（只在一处做）；若有新日期格式，在 dateParser 中扩展并加回归用例。

---

### 7. 分类管道（规则 + AI + 学习）

- **当前状态**：已完成
- **涉及目录或文件**：`lib/receiptEnricher.ts`、`lib/categoryClassifier.ts`、`lib/categoryAiClient.ts`、`lib/categoryLearner.ts`、`lib/categories.ts`、Supabase `classify-item`
- **当前实现了什么**：receiptEnricher 编排整单分类、调用 classifyItem、写 classification_status/confidence、失败时置 null/failed；categoryClassifier 规则优先、每单 AI 调用上限、调用 classify-item；categoryAiClient 超时/重试/并发限制、JWT 校验；categoryLearner 读写 item_category_mapping；categories 定义 16 类 + uncategorized/non_grocery。
- **还缺什么**：规则与 AI 的优先级与回退策略仅在注释与实现中体现，无独立文档；分类 key 与 i18n 的对应关系分散在 categoryPalette 与 locales。
- **主要问题**：分类链路长，调试依赖 __DEV__ 日志；若 classify-item 不稳定，需关注限流与超时是否足够。
- **第二阶段建议动作**：在 docs 中写一条“分类管道”说明（规则 vs AI、失败行为、学习表用途）；必要时为 categoryClassifier/categoryAiClient 加轻量单测。

---

### 8. 数据层（SQLite 与类型）

- **当前状态**：已完成
- **涉及目录或文件**：`lib/db.ts`
- **当前实现了什么**：receipts_v2.db、receipts 表（含 transaction_at、user_edited、user_items_json 等）、item_category_mapping 表、迁移与幂等 ALTER、listReceipts/listReceiptsForList 按 COALESCE(transaction_at,created_at) DESC、saveReceipt/updateReceipt/deleteReceipt/deleteReceipts、学习表读写；ReceiptRow/ReceiptListRow/SaveReceiptParams 类型导出。
- **还缺什么**：无显式备份/恢复；nanoid 未在 package.json 直接声明。
- **主要问题**：__DEV__ 下迁移失败会尝试删表重建，仅适合开发，生产需避免误触。
- **第二阶段建议动作**：在 package.json 中显式添加 nanoid 依赖；若需备份，在设置中提供“导出数据”并文档化。

---

### 9. 配置与环境

- **当前状态**：已完成
- **涉及目录或文件**：`lib/env.ts`、`app.config.js`、`eas.json`、`.env`（未提交）
- **当前实现了什么**：env 从 process.env 与 Expo extra 读 SUPABASE_URL/ANON_KEY、isJwtLike、DEV_DIRECT_GEMINI/GEMINI_API_KEY；app.config 注入 extra、bundleId、versionCode/buildNumber；EAS 三档 profile、appVersionSource remote。
- **还缺什么**：无 env 示例文件（如 .env.example）在仓库中；EAS 环境变量仅文档或 Dashboard 侧配置。
- **主要问题**：无
- **第二阶段建议动作**：增加 .env.example 列出 EXPO_PUBLIC_* 等，便于新人与 CI；敏感 key 不落库。

---

### 10. i18n 与多语言

- **当前状态**：已完成
- **涉及目录或文件**：`lib/i18n.ts`、`locales/zh.json`、`locales/ja.json`、`locales/en.json`
- **当前实现了什么**：系统语言检测 zh/ja/en、t(key, params)、getCurrentLocale、initI18n 在根布局阻塞首屏；文案覆盖首页/历史/设置/反馈/分析/Pro/错误/权限/OCR/分类等；categories 与 categoriesShort 用于标签与 KPI。
- **还缺什么**：无运行时切换语言；部分分析 V2 的 key 带占位符，需保证与 buildInsights 输出一致。
- **主要问题**：ja 中 settings.about.title 为“について”，可能应为“アプリについて”等，属文案审校范畴。
- **第二阶段建议动作**：若需“设置内切换语言”，需扩展 i18n 为可写 currentLocale 并触发重渲染；否则仅做文案审校与占位符校验。

---

### 11. UI 组件与主题

- **当前状态**：部分完成
- **涉及目录或文件**：`components/haptic-tab.tsx`、`components/ui/icon-symbol*.tsx`、`constants/theme.ts`
- **当前实现了什么**：HapticTab 包装 Tab 按钮、IconSymbol 封装 SF Symbol/fallback、Colors 按 colorScheme 提供 tint 等。
- **还缺什么**：无统一 Button/Card/Input 等基础组件；各页 StyleSheet 内联，无全局设计 token（如间距、圆角）的集中管理。
- **主要问题**：重复样式多，后续若统一改版工作量大。
- **第二阶段建议动作**：若计划统一视觉，先收口 constants/theme（间距、圆角、字号），再逐步抽通用组件；不强求一次性完成。

---

### 12. 价格雷达与洞察

- **当前状态**：已完成
- **涉及目录或文件**：`lib/priceRadar.ts`、`lib/buildInsights.ts`、`lib/productNormalizer.ts`、`lib/groceryDetector.ts`
- **当前实现了什么**：从收据 JSON 抽取商品价格、计算最便宜商家、Top 商品、分类价格指数、偏高判断；buildInsights 产出 story/changes/tips/confidence/proTeaser；grocery 判定用于过滤展示与统计。
- **还缺什么**：价格雷达无持久化（每次从收据重算）；洞察为纯计算无缓存。
- **主要问题**：无
- **第二阶段建议动作**：若收据量很大，可考虑对“价格雷达输入”做轻量缓存或抽样；优先级低。

---

### 13. Supabase Edge Functions

- **当前状态**：已完成
- **涉及目录或文件**：`supabase/functions/ocr/`、`ocr-receipt/`、`classify-item/`、`privacy-policy/`、send-feedback（若存在）
- **当前实现了什么**：ocr 与 ocr-receipt 提供 OCR 能力；classify-item 提供分类；privacy-policy 从 Storage legal 桶读 HTML 并返回 utf-8；send-feedback 接收反馈并落库或转发；config.toml 中 privacy-policy verify_jwt=false 以公开访问。
- **还缺什么**：代码中调用 `send-feedback`，但仓库内未发现 `supabase/functions/send-feedback` 目录，需确认是否在其他仓库或已单独部署；各函数无统一健康检查或版本接口。
- **主要问题**：函数级配置（如超时、环境变量）依赖 Supabase 控制台或 config.toml，需与文档同步。
- **第二阶段建议动作**：在文档中列出所有 Edge 函数、用途、所需 env；确认 send-feedback 已部署并可访问。

---

### 14. 错误处理与日志

- **当前状态**：部分完成
- **涉及目录或文件**：各页与 lib 中的 try/catch、Alert、console.error/warn、__DEV__ 分支
- **当前实现了什么**：OCR/分类/反馈等错误映射为用户可读 i18n；关键路径有 try/catch 防崩；__DEV__ 下部分模块打日志（如 DB、CategoryAI）。
- **还缺什么**：无统一错误上报或日志收集；生产环境无结构化日志策略。
- **主要问题**：错误信息部分依赖 error.message 字符串匹配（如 feedback 的“网络”“服务器”），若后端文案变更可能失效。
- **第二阶段建议动作**：若需统计或排查线上问题，可引入轻量错误上报（如 Sentry）；否则保持现状并文档化“错误码与 i18n key 对应关系”。

---

### 15. 测试

- **当前状态**：待开发
- **涉及目录或文件**：`supabase/functions/ocr/tests/ocr.test.ts`、其余无
- **当前实现了什么**：仅 OCR Edge Function 有单测。
- **还缺什么**：前端与 lib 无单测、无集成测、无 E2E。
- **主要问题**：重构或改数据流时回归风险高。
- **第二阶段建议动作**：优先为 db、dateParser、statsCalculator、buildInsights 等纯逻辑加单测；再考虑关键流程的集成测（如“扫描→保存→列表可见”）。

---

# C. 技术债与风险清单

---

### 高优先级技术债

| 问题 | 影响 | 为何现在要管 | 建议 |
|------|------|--------------|------|
| 首页 index.tsx 约 1773 行且含未使用的 inferCategory/applyLocalCategories | 可维护性差、新人难以理解、修改易引入回归 | 第二阶段若继续在首页加功能会进一步膨胀 | 删除死代码；将“扫描流程”抽成 hook 或 lib；饼图/KPI 拆成纯展示组件 |
| nanoid 未在 package.json 中声明 | 依赖可能随上游变更消失或版本漂移 | db 强依赖，构建与运行依赖间接安装 | 在 dependencies 中显式添加 nanoid |
| 分类与 OCR 管道无文档与单测 | 改规则或 AI 行为时难以评估影响 | 第二阶段可能调分类策略或限流 | 写 docs 管道说明；为 categoryClassifier/dateParser 等加轻量单测 |

---

### 中优先级技术债

| 问题 | 影响 | 为何现在要管 | 建议 |
|------|------|--------------|------|
| 图片压缩逻辑在 ocrService 与 receiptAnalyzer 中重复 | 行为可能不一致、修改需改两处 | 后续若改分辨率/格式会重复劳动 | 统一到单一模块（如 receiptAnalyzer）并让 ocrService 调用 |
| 历史列表 listReceiptsForList(200) 无分页 | 收据很多时列表加载慢、内存占用大 | 用户若长期使用会积累大量数据 | 改为分页或虚拟列表，或提高上限并加“加载更多” |
| 详情页部分文案未 i18n（如“未找到该记录”“分类汇总”等） | 多语言不一致 | 与已完成的 i18n 化不一致 | 收进 locales 并替换 |
| 无 .env.example | 新人与 CI 不知需配置哪些变量 | 第二阶段协作或自动化会用到 | 新增 .env.example，列出 EXPO_PUBLIC_* 等，不含真实 key |

---

### 隐性风险

| 问题 | 影响 | 为何现在要管 | 建议 |
|------|------|--------------|------|
| __DEV__ 下 DB 迁移失败会 DROP 表重试 | 生产若误开 __DEV__ 或类似逻辑可能丢数据 | 数据丢失不可逆 | 确保生产构建不执行该分支；或移除自动 DROP，仅日志提示 |
| 错误类型依赖 error.message 字符串包含（如“网络”“服务器”） | 后端或依赖库改文案会导致前端错误分类错误 | 用户看到错误提示不对 | 优先用 HTTP 状态码或约定 error.code；其次文档化当前匹配规则 |
| EAS 使用 remote appVersionSource | 版本号由服务端控制，本地 buildNumber 等可能被忽略 | 若不清楚会误以为改 app.json 即可 | 在 README 或 docs 中说明版本号来源与发布流程 |

---

### 可能影响上线/扩展/稳定性的点

- **上线**：隐私政策 URL、Supabase anon key、send-feedback 是否已部署并可用；EAS 凭证与 profile 是否正确。
- **扩展**：首页与分析页单文件过大，新功能会继续加大复杂度；无统一错误上报，线上问题难定位。
- **稳定性**：classify-item 超时与限流已做，但若上游不稳定仍可能影响整单分类体验；SQLite 单库单表，无备份与恢复入口。

---

# D. 第二阶段任务池（统一颗粒度）

| 任务标题 | 优先级 | 类型 | 关联模块 | 目标 | 验收标准 | 预计改动范围 |
|----------|--------|------|----------|------|----------|--------------|
| 删除首页未使用的 inferCategory 与 applyLocalCategories | P1 | 重构 | 首页 | 去掉死代码，减少噪音 | 搜索无引用，打包与功能不变 | 低 |
| 在 package.json 中显式添加 nanoid 依赖 | P0 | 稳定性 | 数据层 | 避免间接依赖漂移 | 安装与 build 正常，db 行为不变 | 低 |
| 将首页“扫描流程”抽成 hook 或 lib | P1 | 重构 | 首页 | 缩短 index 体量，便于单测 | 扫描单张/多张行为与现有一致，index 行数明显减少 | 中 |
| 编写“分类管道”与“OCR 管道”文档 | P2 | DX | 分类/OCR | 新人与后续改动能理解数据流 | docs 内有一页描述规则 vs AI、失败行为、学习表 | 低 |
| 为 dateParser / statsCalculator / buildInsights 增加单测 | P2 | 测试 | 数据/分析 | 改日期或统计逻辑时能回归 | 关键路径有用例通过 | 中 |
| 历史详情未 i18n 文案收进 locales 并替换 | P2 | 功能 | 历史 | 多语言一致 | 详情页无硬编码中文/日文/英文 | 低 |
| 新增 .env.example 列出所需环境变量 | P2 | DX | 配置 | 协作与 CI 可知需配置项 | 文件存在且无真实 secret | 低 |
| 统一图片压缩入口（仅在一处实现） | P2 | 重构 | OCR/分析管道 | 避免重复与行为不一致 | ocrService 与 receiptAnalyzer 共用同一压缩逻辑 | 中 |
| 首页饼图与 KPI 拆成纯展示组件 | P2 | 重构 | 首页 | 降低首页复杂度，便于复用 | 展示与当前一致，数据由 props 传入 | 中 |
| 分析页“数据准备”抽到 hook 或 lib | P2 | 重构 | 分析页 | 页面只负责展示与交互 | 统计与洞察计算不在页面内，行为一致 | 中 |
| 历史列表分页或虚拟列表 | P2 | 性能 | 历史 | 大量收据时列表不卡顿 | 列表加载与滚动流畅，功能不变 | 中 |
| 错误类型依赖 error.message 的替换为 code/status | P2 | 稳定性 | 反馈/OCR/分类 | 错误分类不依赖文案 | 使用 HTTP 状态或约定 code 做分支 | 中 |

---

# E. 推荐开发顺序

- **第 1 批（先做）**  
  - 删除首页死代码（inferCategory/applyLocalCategories）。  
  - 显式添加 nanoid 依赖。  
  - 新增 .env.example。  
  **依据**：改动小、风险低、立刻减少噪音与依赖隐患，不阻塞后续重构。

- **第 2 批（再做）**  
  - 将首页“扫描流程”抽成 hook/lib。  
  - 编写分类与 OCR 管道文档。  
  - 历史详情未 i18n 文案收进 locales。  
  **依据**：为后续改首页与分类打基础；文档与 i18n 有利于协作与多语言一致性。

- **第 3 批（按需）**  
  - 为 dateParser、statsCalculator、buildInsights 加单测。  
  - 统一图片压缩、饼图/KPI 与分析页数据准备拆分。  
  - 历史列表分页或虚拟列表、错误分类改为 code/status。  
  **依据**：测试与重构成本较高，适合在功能稳定后逐步做；分页与错误分类在数据量或运维需求明确后再推进。

---

# F. 需要我确认的决策点

1. **Pro 功能**：当前为占位。第二阶段是否实现“订阅/支付/权益”，还是继续占位到更晚阶段？若实现，需单独排期与产品方案。
2. **首页拆分粒度**：是否接受“扫描流程 hook + 饼图/KPI 组件”这一粒度，还是希望更细（例如单文件不超过 300 行）？
3. **历史详情“未找到该记录”“分类汇总”等**：是否全部收进 i18n（与 COPY_REVIEW 对齐），还是部分保留中文？
4. **测试优先级**：是否同意优先覆盖 db、dateParser、statsCalculator、buildInsights，再考虑 UI 或 E2E？
5. **错误上报**：是否有计划接入 Sentry 或类似服务？若无，是否明确“仅依赖 __DEV__ 与控制台”即可？
6. **send-feedback Edge Function**：是否已部署且 URL 与 anon key 正确？若未部署，反馈提交会失败，需在第二阶段前确认。

---

# 已具备复用价值的部分

- **数据层**：db.ts 的 schema、迁移策略、ReceiptRow/ReceiptListRow 类型、list/save/update/delete 接口。
- **分类体系**：categories.ts（16 类 + special）、categoryPalette（颜色与标签）、getItemTagDisplay、isGroceryCategory/isExcludedFromAnalytics。
- **配置与 env**：env.ts 的 getSupabaseUrl/getSupabaseAnonKey、isJwtLike、getExtraValue；app.config.js 的 extra 注入。
- **i18n**：lib/i18n.ts、locales 三语结构、t(key, params)、getCurrentLocale。
- **OCR 与收据分析**：receiptAnalyzer 的 Edge + 直连 Gemini 双路径、transactionDate 抽取、dateParser 的解析逻辑。
- **分类管道**：receiptEnricher 编排、categoryClassifier 规则+AI、categoryAiClient 超时与并发、categoryLearner 学习表。
- **分析逻辑**：statsCalculator、buildInsights、priceRadar、groceryDetector、productNormalizer。
- **导航与 Tab**：expo-router 文件路由、Tab 与隐藏屏的配置方式。
- **EAS 与构建**：eas.json、production profile、当前修复后的 bundle 可成功打出 iOS 包。

---

# 第二阶段最容易失控的部分

1. **首页（index.tsx）**：若继续在首页堆功能（新图表、新入口、新业务规则），而不做“扫描流程 + 展示组件”拆分，文件会继续膨胀，回归成本高。
2. **分类与 AI 行为**：规则与 AI 的优先级、限流、超时、失败回退若频繁调整且无文档与单测，容易产生“改一处崩另一处”或行为难以说清。
3. **分析页**：若在分析页直接加更多维度（新图表、新筛选、导出）而不先把“数据准备”抽离，会重复“大页面 + 强耦合”的模式。
4. **Pro 功能**：若决定做 Pro 但未先定边界（哪些能力付费、哪些免费、如何校验），容易与现有“全部本地”的架构混在一起，导致逻辑散落。
5. **i18n 与文案**：若新增功能不统一走 t() 或新增 key 不规范，会重新积累硬编码与 COPY_REVIEW 债务。
6. **Supabase 与 env**：若新增 Edge Function 或环境变量未在文档与 .env.example 中同步，协作与部署会反复踩坑。

---

# 总结

**当前最该先抓的 3 件事**

1. **清理首页死代码并显式声明 nanoid**：立即降低噪音与依赖风险，不改变行为。  
2. **把首页“扫描流程”抽成 hook/lib**：为后续首页扩展与单测打基础，避免单文件继续膨胀。  
3. **确认 send-feedback 与隐私政策等 Edge 能力已部署且可用**：保证设置/反馈与合规链路在第二阶段可依赖。

**当前最不该急着做的 3 件事**

1. **不要立刻做大而全的 Pro 订阅与支付**：需先定产品边界与计费方案，再排期。  
2. **不要立刻做全量 UI 组件库或设计系统**：在未定版的前提下，先收口 theme 与少量通用组件即可。  
3. **不要立刻上 E2E 或全量单测**：优先核心数据与管道（db、dateParser、statsCalculator、buildInsights）的单测与文档，再考虑 UI 与 E2E。

---

*文档生成后未修改任何业务代码，仅作第二阶段排期与对齐使用。*
