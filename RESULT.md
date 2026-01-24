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

i18n 初始化和分类标签统一化修复：
- **问题**：页面进入时先显示英文后显示中文的闪烁；分类名称在全站显示不一致（直接显示 category_id 如 meat_seafood / other_grocery）
- **原因**：
  - i18n 使用 lazy loading，在首次使用时才检测 locale，导致初始闪烁
  - 分类显示直接使用 category_id，没有统一的标签映射
- **修复**：
  - 创建 `lib/categoryLabels.ts`：
    - 提供所有分类的三语标签映射（zh/ja/en）
    - 导出 `getCategoryLabel(categoryId, locale)` helper 函数
  - 修改 `lib/i18n.ts`：
    - 移除 lazy loading，改为同步初始化
    - 添加 `initI18n()` 函数用于在 app 启动时初始化
    - locale 取值规则：优先系统语言（expo-localization），仅支持 'zh' | 'ja' | 'en'，其他 fallback 到 'en'
  - 修改 `app/_layout.tsx`：
    - 使用 `expo-splash-screen` 防止 auto-hide
    - 在渲染前调用 `initI18n()` 等待 i18n ready
    - i18n 初始化完成后再 hide splash screen 并渲染 App
  - 更新所有显示 category_id 的地方使用 `getCategoryLabel()`：
    - `app/(tabs)/index.tsx`: Home 饼图 legend 列表、insight 消息中的分类名称
    - `app/(tabs)/history/[id].tsx`: 分类汇总、分类编辑选项
    - `app/(tabs)/analysis.tsx`: 所有分类输出（topCategories、categoryIndex）
- **验证步骤**：
  1. 验证无闪烁：
     - 启动应用（iOS 系统语言设为中文）
     - 应该直接显示中文界面，无英文闪烁
     - 切换系统语言为日文/英文，重启应用，应该直接显示对应语言
  2. 验证分类三语正常：
     - 扫描一张超市小票
     - 进入 Home 页面，查看饼图 legend，分类应该显示为中文标签（如"肉鱼海鲜"而不是"meat_seafood"）
     - 进入 Analysis 页面，查看"主要类别"，分类应该显示为中文标签
     - 进入 Receipt Detail 页面，查看"分类汇总"，分类应该显示为中文标签
     - 编辑商品分类时，分类选项应该显示为中文标签
     - 切换系统语言为日文/英文，重复上述步骤，分类应该显示为对应语言的标签

分类配色统一和饼图/列表/详情一致：
- **问题**：分类颜色在不同组件中硬编码，不一致；分类名称直接显示 categoryId（如 meat_seafood）
- **原因**：
  - 颜色在多个组件中硬编码（CATEGORY_COLORS），不同组件可能使用不同颜色
  - 分类名称直接使用 categoryId，没有统一的 i18n 接口
- **修复**：
  - 创建 `lib/categoryPalette.ts` 统一配色和标签获取：
    - `getCategoryColor(categoryId)`: 返回统一的颜色（hex），同一 categoryId 永远返回同一个颜色
    - `getCategoryLabel(categoryId)`: 使用 `t(\`category.${categoryId}\`)` 获取标签，fallback 到 categoryId
    - `getCategoryColorMap()`: 获取完整颜色映射（用于调试）
    - 提供至少 18 种颜色（16 个 grocery + 2 个 special），颜色选择避免过浅或过深
  - 更新所有使用分类的地方：
    - `app/(tabs)/index.tsx`:
      - 移除硬编码的 `CATEGORY_COLORS` 和 `CATEGORIES`
      - 饼图使用 `getCategoryColor(item.category)` 设置 fill
      - 分类列表使用 `getCategoryColor(item.category)` 设置圆点颜色
      - 分类名称使用 `getCategoryLabel(item.category)`（不再需要 getCurrentLocale 参数）
      - Insight 消息中的分类名称也使用 `getCategoryLabel()`
    - `app/(tabs)/history/[id].tsx`:
      - 分类汇总列表添加左侧色条（使用 `getCategoryColor()`）
      - 分类名称使用 `getCategoryLabel()`（不再需要 getCurrentLocale 参数）
      - 分类编辑选项使用 `getCategoryLabel()`
    - `app/(tabs)/analysis.tsx`:
      - 所有分类输出使用 `getCategoryLabel()`（不再需要 getCurrentLocale 参数）
  - 确保 locales 文件包含所有分类的翻译：
    - `locales/zh.json`: 已有 `category.*` 翻译键（18 个分类）
    - `locales/ja.json`: 已有 `category.*` 翻译键（18 个分类）
    - `locales/en.json`: 已有 `category.*` 翻译键（18 个分类）
- **验证步骤**：
  1. 验证配色一致：
     - 扫描一张包含多个分类的超市小票
     - 进入 Home 页面，查看饼图和分类列表
     - 同一分类在饼图和列表中的颜色应该完全一致
     - 进入 Receipt Detail 页面，查看"分类汇总"
     - 分类汇总中的颜色应该与 Home 页面的饼图颜色一致
  2. 验证分类名称显示：
     - 所有地方不应该再出现 `meat_seafood` 这种 raw id
     - 应该显示为对应的中文标签（如"肉类海鲜"）
     - 切换系统语言为日文/英文，分类名称应该显示为对应语言的标签
  3. 验证无英文闪烁：
     - 由于 i18n 已在 app 启动时初始化（见之前的修复），分类名称应该直接显示正确语言
     - 如果仍有闪烁，检查 `app/_layout.tsx` 中的 `initI18n()` 是否在渲染前完成
  4. 验证颜色可见性：
     - 所有颜色在白色背景上应该清晰可见
     - 颜色不应该过浅导致看不清，也不应该过深导致文字看不清

分类准确率提升（混合分类方案）：
- **目标**：显著提升分类准确率（V1 核心），采用"规则优先 + AI 兜底 + 本地学习映射"的混合分类方案
- **现状**：原有分类逻辑分散在多个文件，准确率低，缺乏可持续迭代机制
- **修复**：
  - 创建 `lib/categoryClassifier.ts` 统一分类服务：
    - 输入：`{ rawName, normalizedName, merchantName?, price?, locale? }`
    - 输出：`{ categoryId, confidence, source, reason? }`
    - source 枚举：'mapping' | 'rules' | 'ai' | 'fallback'
  - 实现分层策略（严格按顺序执行）：
    1. **本地映射优先**（最高权重）：
       - key：normalizedName + optional merchantHint
       - 命中则 confidence=1.0, source='mapping'
    2. **规则/词典匹配**（高置信）：
       - 基于关键词、常见商品词、店铺特征等
       - 给出 confidence（0.8~0.95）
       - 高置信度（>=0.85）自动学习到 mapping 表
    3. **AI 兜底**（仅处理剩余不确定项）：
       - 通过 Supabase Edge Function `/functions/v1/classify-item` 调用
       - 只允许从现有 category_id 列表中选择
       - 输出必须包含 categoryId 与 confidence(0~1)
       - 若 confidence < 0.6 -> 返回 fallback
       - 高置信度（>=0.85）自动学习到 mapping 表
    4. **fallback**：categoryId='other_grocery', confidence=0.0
  - 更新数据库表结构：
    - `item_category_mapping` 表添加 `merchant_hint` 和 `confidence` 字段
    - 主键改为 `(normalized_name, merchant_hint)` 复合键
    - 添加自动迁移逻辑（兼容旧表结构）
  - 学习机制：
    - 用户编辑分类时自动写入 mapping 表
    - 高置信度分类（mapping/rules/ai>=0.85）自动学习
    - 写入时去重/更新（INSERT OR REPLACE）
  - 更新 `lib/categoryLearner.ts`：
    - 支持新的表结构（merchant_hint, confidence）
    - 提供 `learnCategoryMapping()` 和 `getLearnedCategory()` 函数
    - 查询时优先匹配带 merchant_hint 的映射，fallback 到通用映射
  - 更新 `lib/receiptEnricher.ts`：
    - 使用统一的 `classifyItem()` 函数
    - 添加分类统计日志（每张小票输出一次）
  - 创建测试脚本 `scripts/test-category-classifier.js`：
    - 模拟分类逻辑，测试规则匹配
    - 可独立运行，无需 React Native 环境
- **验证步骤**：
  1. 验证 mapping 表创建成功：
     - 启动应用并扫描一张小票
     - 不应该再出现 "no such table: item_category_mapping" 错误
     - 检查数据库，应该看到表结构包含 `merchant_hint` 和 `confidence` 字段
  2. 验证分类准确率提升：
     - 扫描一张包含常见商品的超市小票（如：牛乳、りんご、パン等）
     - 检查控制台日志，应该看到 `[CategoryClassifier] Stats: mapping=X rules=Y ai=Z fallback=W`
     - 进入 Receipt Detail 页面，查看商品分类，应该看到正确的分类（如"乳制品/蛋"而不是"other_grocery"）
  3. 验证学习机制：
     - 编辑一个商品的分类（如将"不明商品"改为"生鲜蔬果"）
     - 扫描另一张包含相同商品的小票
     - 该商品应该自动分类为"生鲜蔬果"（source='mapping'）
  4. 验证规则匹配：
     - 扫描包含规则匹配商品的收据（如"牛乳"、"ビール"、"パン"）
     - 这些商品应该通过规则匹配分类（source='rules'），confidence >= 0.8
  5. 运行测试脚本：
     ```bash
     node scripts/test-category-classifier.js
     ```
     - 应该看到所有测试通过

i18n key 泄露与扫描相关 UI 修复：
- **问题**：ActionSheet/Alert 显示原始 key（如 `scan.title`、`scan.takePhoto` 等）；部分界面先英文后中文闪烁；分类名可能直接显示 raw categoryId。
- **原因**：
  - 扫描弹窗使用 `t('scan.xxx')`，而 locales 中 key 位于 `home.scan.*`，`t()` 查不到则回退为 key，导致 raw key 展示。
  - 根 layout 虽在 i18n 就绪后渲染，注释与流程不够明确。
  - Receipt Detail 商品行用 `t(\`category.${it.category}\`)`，未统一走 `getCategoryLabel`，且缺 key 时可能显示 key。
- **修复**：
  1. **扫描相关 i18n**（`app/(tabs)/index.tsx`）：
     - 所有 `t('scan.*')` 改为 `t('home.scan.*')`（与 `locales/*.json` 中 `home.scan` 一致）。
     - 涉及：来源选择 Alert（title、cancel、takePhoto、chooseFromLibrary）、两次确认识别 Alert（confirmTitle、confirmMessage、confirmCancel、confirmAction）。
     - 成功/错误 Alert、按钮文案已使用 `home.scan.*`，未改动。
  2. **分类标签**（`app/(tabs)/history/[id].tsx`）：
     - 商品行分类由 `t(\`category.${it.category}\`)` / `t('category.uncategorized')` 改为 `getCategoryLabel(it.category || 'uncategorized')`，统一走 `lib/categoryPalette`，避免 raw categoryId 或 key 泄露。
     - 移除未使用的 `t` 导入。
  3. **根 layout**（`app/_layout.tsx`）：
     - 明确注释：在 i18n 就绪前不渲染 App，避免英文闪烁。
     - 保持 `initI18n()` → `setIsReady(true)` → `SplashScreen.hideAsync()` 顺序，渲染前完成 i18n 初始化。
- **验收**：
  1. **扫描弹窗语言**：系统语言 zh/ja/en 下，点击「扫描小票」→ 来源选择 Alert 立即显示对应语言（如 zh：「扫描小票」「拍照」「从相册选择」「取消」），无 `scan.title` 等 raw key。
  2. **无 raw key**：全应用 UI 中不出现 `scan.xxx`、`common.xxx`、`category.xxx` 等原始 key。
  3. **无英文闪烁**：冷启动后首屏（含 Home、Tab 等）直接为系统语言，无先英后中/日闪烁。
  4. **分类显示**：Receipt Detail 等处的分类均通过 `getCategoryLabel` 或 `t(\`category.${id}\`)` + fallback，无 `meat_seafood` 等 raw categoryId。

分类器统一化（PR1 - 规则优先 + 本地映射）：
- **目标**：提升分类准确率，统一分类逻辑到一个模块，使用规则优先 + 本地映射策略（不含 AI）。
- **实现**：
  1. **创建 `lib/categoryClassifier.ts`**（简化版，不含 AI）：
     - 导出类型：`ClassifyInput`、`ClassifyOutput`
     - 导出函数：`classifyItem(input: ClassifyInput): Promise<ClassifyOutput>`
     - 分类策略（按顺序）：
       a) **本地映射优先**：通过 `getLearnedCategory` 查询已学习的映射，命中则 `confidence=1.0`、`source='mapping'`
       b) **规则匹配**：基于关键词的确定性规则（针对日本超市收据），覆盖主要类别（dairy_eggs、produce、meat_seafood、bakery、staples、quick_meals、frozen_foods、canned_preserved、beverages_other、health_supplements、snacks_sweets、non_alcoholic_drinks、alcohol、condiments、household），返回 `confidence 0.8~0.95` 和简短 reason
       c) **fallback**：`other_grocery`、`confidence=0.0`、`source='fallback'`
     - 统计功能：`resetClassificationStats()`、`getClassificationStats()`（每张收据统计 mapping/rules/fallback 数量）
  2. **更新 `lib/receiptEnricher.ts`**：
     - `applyCategoriesWithLearning` 已使用 `classifyItem`（无需修改）
     - 更新日志：移除对 `stats.ai` 的引用，只记录 `mapping`、`rules`、`fallback`
     - 每张收据处理完成后输出：`[CategoryClassifier] Stats: mapping=X rules=Y fallback=Z`
  3. **测试脚本 `scripts/test-category-classifier.js`**：
     - 包含 17 个日本商品测试用例，覆盖主要类别和 fallback
     - 验证规则匹配逻辑（独立运行，无需 React Native 环境）
     - 所有测试通过 ✅
- **技术细节**：
  - 规则匹配顺序优化：先检查更具体的模式（如"牛乳"），再检查通用模式（如"牛"），避免误匹配
  - 规则 confidence 范围：0.8~0.95（根据匹配确定性）
  - 本地映射 confidence：1.0（用户编辑或高置信度学习）
  - fallback confidence：0.0（无法分类）
- **验收步骤**：
  1. **运行测试脚本**：
     ```bash
     node scripts/test-category-classifier.js
     ```
     - 应该看到所有 17 个测试通过
  2. **验证分类器集成**：
     - 扫描一张超市小票
     - 检查控制台日志，应该看到 `[CategoryClassifier] Stats: mapping=X rules=Y fallback=Z`
     - 进入 Receipt Detail 页面，查看商品分类，应该看到正确的分类（如"牛乳"→"乳制品/蛋"）
  3. **验证本地映射**：
     - 编辑一个商品的分类（如将"不明商品"改为"生鲜蔬果"）
     - 扫描另一张包含相同商品的小票
     - 该商品应该自动分类为"生鲜蔬果"（source='mapping'）
  4. **验证规则匹配**：
     - 扫描包含规则匹配商品的收据（如"牛乳"、"ビール"、"パン"、"りんご"）
     - 这些商品应该通过规则匹配分类（source='rules'），confidence >= 0.8

分类学习持久化与商家感知（PR2）：
- **目标**：让分类学习持久化且支持商家感知，提高准确率。
- **实现**：
  1. **数据库迁移**（`lib/db.ts`）：
     - 确保 `item_category_mapping` 表结构：
       - `normalized_name TEXT NOT NULL`
       - `merchant_hint TEXT NOT NULL DEFAULT ''`（使用空字符串而非 NULL）
       - `category_id TEXT NOT NULL`
       - `confidence REAL NOT NULL DEFAULT 1.0`
       - `updated_at INTEGER NOT NULL`
       - 复合主键：`(normalized_name, merchant_hint)`
     - 迁移逻辑：
       - 如果旧表存在但没有 `merchant_hint` 字段：创建新表，迁移数据（将 NULL merchant_hint 转换为 ''）
       - 如果旧表已有 `merchant_hint` 但可能为 NULL：更新所有 NULL 为 ''，确保 `confidence` 字段存在
       - 确保索引存在：`idx_item_category_mapping_updated_at`、`idx_item_category_mapping_name`、`idx_item_category_mapping_name_hint`
     - 向后兼容：迁移不会丢失用户数据，所有现有映射都会保留
  2. **分类学习器更新**（`lib/categoryLearner.ts`）：
     - `learnCategoryMapping`：将 `null` merchantHint 转换为 ''（空字符串），确保一致性
     - `getLearnedCategory`：查询策略：
       a) 优先查询商家特定映射（`merchant_hint = normalized merchant`）
       b) 回退到通用映射（`merchant_hint = ''`）
     - 支持商家感知：同一商品在不同商家可以有不同分类
  3. **分类器自动学习**（`lib/categoryClassifier.ts`）：
     - 规则分类后，如果 `confidence >= 0.85`，自动调用 `learnCategoryMapping` 保存学习结果
     - merchantHint 使用标准化后的商家名称，如果未知则为 ''
     - 高置信度规则匹配会自动持久化，下次扫描相同商品时直接命中映射
- **迁移说明**：
  - 迁移是自动的，用户无需手动操作
  - 首次启动应用时会自动检测并迁移表结构
  - 如果迁移失败（开发模式），会自动重置数据库（仅开发模式）
  - 生产环境：迁移失败会记录警告，但不会重置数据库
- **验收步骤**：
  1. **验证迁移**：
     - 如果设备已有旧数据，启动应用后检查数据库
     - 所有 `merchant_hint` 应该为 ''（空字符串）而不是 NULL
     - 所有现有映射应该保留
  2. **验证商家感知学习**：
     - 扫描来自商家 A 的小票（如"セブンイレブン"），包含商品"牛乳"
     - 编辑该商品分类为"乳制品/蛋"（这会学习商家特定的映射）
     - 扫描来自商家 B 的小票（如"イオン"），包含相同商品"牛乳"
     - 如果商家 B 没有特定映射，应该使用通用映射或规则匹配
  3. **验证自动学习**：
     - 扫描包含高置信度规则匹配商品的收据（如"牛乳" confidence=0.9、"ビール" confidence=0.9）
     - 这些商品应该自动学习到映射表
     - 再次扫描相同商品（相同商家），应该直接命中映射（source='mapping'，confidence=1.0）
  4. **验证通用映射**：
     - 扫描商品"牛乳"（无商家信息或商家未知）
     - 如果之前有通用映射（merchant_hint=''），应该直接命中
     - 如果没有通用映射，应该使用规则匹配，然后自动学习（confidence >= 0.85）

AI 兜底分类（PR3 - Supabase Edge Function）：
- **目标**：添加 AI 兜底分类作为最后手段，通过 Supabase Edge Function，包含熔断器和自动学习。
- **实现**：
  1. **AI 客户端**（`lib/categoryAiClient.ts`）：
     - 导出 `classifyViaEdgeFunction(input: AiClassifyInput): Promise<AiClassifyResult | null>`
     - 使用 `getSupabaseUrl()` 和 `getSupabaseAnonKey()` 从 env helper 读取配置
     - POST 请求到 `${SUPABASE_URL}/functions/v1/classify-item`
     - 请求头：`Authorization: Bearer {SUPABASE_ANON_KEY}`、`apikey`、`x-device-id`
     - 请求体 JSON：`{ rawName, normalizedName, merchantName, price, locale, deviceId, appVersion, platform }`
     - 超时控制：使用 `AbortController` 强制 5000ms 超时
     - 错误处理：
       - HTTP 状态非 2xx：返回 null，记录调试日志（每个会话每个状态码只记录一次）
       - 响应缺少 categoryId：返回 null
       - 网络错误/超时：返回 null，优雅降级
     - 日志去重：使用会话级别的 `_lastLogKey` 避免重复日志
  2. **分类器更新**（`lib/categoryClassifier.ts`）：
     - 更新 `ClassifyOutput` 类型：`source: 'mapping' | 'rules' | 'ai' | 'fallback'`
     - 更新统计：添加 `ai` 计数（`mapping/rules/ai/fallback`）
     - 分类顺序：`mapping` > `rules` > `ai` > `fallback`
     - AI 调用条件：仅在 `rules confidence < 0.8` 且 `mapping miss` 时调用
     - 熔断器（in-memory singleton）：
       - 状态：`consecutiveFailures`、`blockedUntil`（ms 时间戳）、`lastLogKey`
       - 规则：
         - 如果 `blockedUntil > Date.now()` => 跳过 AI 调用
         - AI 失败时：`consecutiveFailures++`
         - 如果 `consecutiveFailures >= 3` => 设置 `blockedUntil = now + 10 minutes`
         - AI 成功时：重置 `consecutiveFailures=0`、`blockedUntil=0`
     - AI 结果处理：
       - 如果 `confidence >= 0.6` 且 categoryId 有效：
         - 返回 `{categoryId, confidence, source:'ai', reason}`
         - 自动学习到本地映射：`learnCategoryMapping(normalizedName, merchantHint, categoryId, confidence)`
         - merchantHint = 标准化后的 merchantName 或 ''
       - 否则：降级到 fallback
     - 失败处理：所有失败（网络错误、超时、无效响应）都优雅降级到 fallback，不会中断扫描
  3. **统计和日志**（`lib/receiptEnricher.ts`）：
     - 每张收据处理完成后输出：`[CategoryClassifier] Stats: mapping=X rules=Y ai=Z fallback=W`
  4. **测试脚本**（`scripts/test-category-classifier.js`）：
     - 添加 `SIMULATE_AI=1` 环境变量开关，模拟 AI 路径（无需网络）
     - 现有规则测试仍然通过
- **Supabase Edge Function 参考**（`supabase/functions/classify-item/index.ts` 骨架）：
  ```typescript
  // Expected request body:
  {
    rawName: string;
    normalizedName: string;
    merchantName?: string | null;
    price?: number | null;
    locale?: string;
    deviceId: string;
    appVersion: string;
    platform: 'ios' | 'android' | 'web';
  }
  
  // Expected response JSON:
  {
    categoryId: string;  // Must be one of GROCERY_CATEGORIES
    confidence: number;  // 0.0 ~ 1.0
    reason?: string;    // Optional explanation
  }
  
  // Error response (any non-2xx status):
  // Client will gracefully degrade to fallback
  ```
- **验收步骤**：
  1. **验证 AI 调用**：
     - 扫描包含无法通过规则匹配的商品（confidence < 0.8）
     - 检查控制台日志，应该看到 `[CategoryClassifier] Stats: mapping=X rules=Y ai=Z fallback=W`
     - 如果 AI 成功，`ai` 计数应该 > 0
  2. **验证熔断器**：
     - 模拟 3 次连续 AI 失败（例如：断开网络或 Edge Function 返回 500）
     - 第 4 次扫描时，应该跳过 AI 调用（熔断器打开）
     - 检查控制台日志，应该看到 "Circuit breaker opened" 警告（仅一次）
     - 等待 10 分钟后，熔断器应该自动恢复
  3. **验证自动学习**：
     - 扫描无法通过规则匹配的商品，AI 返回分类（confidence >= 0.6）
     - 再次扫描相同商品（相同商家），应该直接命中映射（source='mapping'）
  4. **验证优雅降级**：
     - 断开网络或 Edge Function 不可用
     - 扫描应该继续完成，所有商品应该降级到 fallback（`other_grocery`）
     - 不应该出现崩溃或阻塞
  5. **验证超时**：
     - 模拟 Edge Function 响应延迟 > 5 秒
     - 应该看到超时日志（仅一次），然后降级到 fallback
  6. **验证日志去重**：
     - 多次扫描失败的商品
     - 相同类型的错误（如超时、网络错误）应该只记录一次

History 排序与 Home 默认筛选修复：
- **问题**：
  - History 列表按扫描时间（created_at）排序，而不是小票上的实际交易时间
  - Home 页面默认选中"全部"，用户每次都需要手动切换到 30 天
- **修复**：
  1. **History 排序**（`lib/db.ts`、`app/(tabs)/history/index.tsx`）：
     - 添加 `transaction_at` 字段到 `ReceiptRow` 类型和数据库 schema
     - 数据库迁移：如果旧表没有 `transaction_at`，自动添加字段（允许 NULL）
     - 添加索引：`idx_receipts_transaction_at` 用于排序
     - `saveReceipt` 更新：
       - 从 `analysis.transactionDate` 提取交易日期
       - 使用 `parseReceiptDateTime` 解析为 timestamp（支持多种日期格式）
       - 如果解析失败，保存为 NULL（查询时 fallback 到 created_at）
     - `listReceipts` 更新：
       - 排序改为：`ORDER BY COALESCE(transaction_at, created_at) ASC`（从过去到现在）
       - SELECT 语句返回：`COALESCE(transaction_at, created_at) as transaction_at`
     - `getReceipt` 更新：同样返回 `COALESCE(transaction_at, created_at) as transaction_at`
     - History 列表显示：使用 `item.transaction_at || item.created_at` 显示日期
  2. **Home 默认筛选**（`lib/settingsStore.ts`、`app/(tabs)/index.tsx`）：
     - 创建 `lib/settingsStore.ts`：
       - `getHomeTimeRange()`: 从 SecureStore 读取，默认返回 '30D'
       - `setHomeTimeRange(range)`: 保存到 SecureStore
       - 使用 `expo-secure-store`（项目已有）
     - Home 屏幕更新：
       - 默认 `timeRange` 状态改为 '30D'（而不是 'ALL'）
       - 组件加载时：`useEffect` 调用 `getHomeTimeRange()` 读取保存的偏好
       - 用户切换时：`handleTimeRangeChange` 调用 `setHomeTimeRange()` 保存偏好
       - 所有 `setTimeRange` 调用改为 `handleTimeRangeChange`
     - 时间过滤逻辑更新：使用 `transaction_at || created_at` 进行过滤
- **技术细节**：
  - `transaction_at` 字段允许 NULL，查询时使用 `COALESCE(transaction_at, created_at)` fallback
  - 日期解析：优先尝试 ISO 格式，失败则使用 `parseReceiptDateTime` 支持多种格式
  - 持久化存储：使用 SecureStore（已有依赖），失败时降级到默认值，不阻塞 UI
- **验收步骤**：
  1. **验证 History 排序**：
     - 扫描多张小票（不同日期的小票）
     - 进入 History 页面
     - 列表应该按小票上的交易时间排序（从过去到现在，ASC）
     - 如果小票没有 transactionDate，应该 fallback 到 created_at（扫描时间）
  2. **验证 Home 默认筛选**：
     - 首次进入 Home 页面
     - 应该默认选中"30天"（而不是"全部"）
     - 切换为"7天"或"全部"，退出应用再进入
     - 应该保持上次选择（30天/7天/全部）
  3. **验证 transaction_at 提取**：
     - 扫描一张包含日期的小票（OCR 应该识别出 transactionDate）
     - 检查数据库，应该看到 `transaction_at` 字段有值（timestamp）
     - History 列表应该使用这个时间排序和显示
  4. **验证向后兼容**：
     - 如果设备已有旧数据（没有 transaction_at）
     - 启动应用后，旧数据应该使用 created_at 排序和显示
     - 新扫描的小票应该使用 transaction_at（如果有）

反馈功能修复（App 内提交）：
- **问题**：反馈功能使用 mailto 跳转到系统邮箱，用户体验不佳，且硬编码了邮件地址。
- **修复**：
  1. **更新 `lib/feedbackService.ts`**：
     - 实现 `submitFeedback(payload: FeedbackPayload): Promise<void>`
     - 调用 Supabase Edge Function：`POST {SUPABASE_URL}/functions/v1/send-feedback`
     - 请求头：`Authorization: Bearer {SUPABASE_ANON_KEY}`、`apikey`、`x-device-id`
     - 请求体包含：`message`（必填）、`email`（可选）、`locale`、`appVersion`、`platform`、`deviceId`、`receiptId`（最近一次扫描的收据 ID，如有）
     - 自动获取：deviceId（通过 `getDeviceId()`）、appVersion（从 Constants）、platform（从 Platform.OS）、locale（从 `getCurrentLocale()`）、receiptId（从 `listReceipts(1)` 获取最近一条）
     - 错误处理：
       - HTTP 状态非 2xx：根据状态码返回友好的错误消息（网络错误/服务器错误/请求错误）
       - 网络错误：返回"提交失败（网络错误）"
       - 开发模式：记录请求日志（不含敏感数据）
  2. **更新 `app/(tabs)/feedback.tsx`**：
     - 移除 `Linking.openURL('mailto:...')` 和 `MailCompose` 相关代码
     - 改为调用 `submitFeedback()` 函数
     - 添加 `submitting` 状态，防止重复提交
     - 成功时：显示 Alert "已提交"，清空输入框
     - 失败时：显示 Alert 错误消息（根据错误类型显示不同消息），不清空输入
     - 提交按钮在提交中时显示"提交中..."并禁用
  3. **更新 locales**（`locales/zh.json`、`locales/ja.json`、`locales/en.json`）：
     - 移除 `feedback.error.noEmailApp`（不再需要）
     - 添加 `feedback.error.network`："提交失败（网络错误）"
     - 添加 `feedback.error.server`："提交失败（服务器错误）"
     - 更新 `feedback.success.message`："已提交"（简化）
     - 添加 `feedback.success.title`："成功"
- **Supabase Edge Function 参考**（`supabase/functions/send-feedback/index.ts` 骨架）：
  ```typescript
  // Expected request body:
  {
    message: string;        // Required: feedback content
    email?: string | null;  // Optional: contact email
    locale: string;         // e.g., 'zh', 'ja', 'en'
    appVersion: string;     // e.g., '1.0.0'
    platform: 'ios' | 'android' | 'web';
    deviceId: string;      // Device identifier
    receiptId?: string | null; // Optional: most recent receipt ID
  }
  
  // Expected response (2xx):
  {
    success: true;
    message?: string; // Optional success message
  }
  
  // Error response (non-2xx):
  // Client will show user-friendly error message
  ```
- **验收步骤**：
  1. **验证不跳转邮箱**：
     - 进入 Settings -> Feedback 页面
     - 输入反馈内容，点击"提交"
     - 应该不会跳转到系统邮箱 App
     - 应该显示 Alert "已提交"（成功时）或错误消息（失败时）
  2. **验证请求日志**：
     - 提交反馈时，检查控制台日志
     - 应该看到 `[Feedback] Submitting feedback:` 日志（不含敏感数据）
     - 成功时应该看到 `[Feedback] Submission successful`
     - 失败时应该看到 `[Feedback] Submission failed (HTTP XXX):` 错误信息
  3. **验证成功流程**：
     - Edge Function 返回 2xx 时
     - UI 应该显示 Alert "已提交"
     - 输入框应该被清空
  4. **验证失败流程**：
     - 模拟网络错误或 Edge Function 返回非 2xx
     - UI 应该显示 Alert 错误消息（根据错误类型：网络错误/服务器错误/请求错误）
     - 输入框不应该被清空（用户可以重试）
     - 不应该崩溃
  5. **验证防重复提交**：
     - 点击"提交"后，按钮应该显示"提交中..."并禁用
     - 在提交完成前，再次点击应该无效

相册多选与顺序处理功能：
- **目标**：支持从相册多选照片，顺序处理每张图片，每张保存为独立收据。
- **实现**：
  1. **相册多选**（`app/(tabs)/index.tsx`）：
     - `launchImageLibraryAsync` 启用 `allowsMultipleSelection: true` 和 `orderedSelection: true`
     - 相机拍照仍为单张（不变）
  2. **顺序处理逻辑**：
     - 新增 `processMultipleReceiptImages(uris: string[])` 函数
     - 顺序处理每张图片：`analyzeReceiptImage` → `applyCategoriesWithLearning` → `saveReceipt`
     - 单张失败不影响后续处理，继续处理下一张
     - 所有处理完成后统一刷新数据（`loadReceipts()`）
  3. **进度显示**：
     - 新增 `processingProgress` 状态：`{ current: number, total: number } | null`
     - 扫描按钮显示进度：`"处理中 {current}/{total}"`（通过 `t('home.scan.processingMulti')`）
     - 处理过程中按钮禁用，防止重复触发
  4. **完成摘要**：
     - 所有图片处理完成后显示摘要 Alert：`"完成：成功 {ok}，失败 {fail}"`（通过 `t('home.scan.doneSummary')`）
     - 单张图片仍使用原有流程（包含复活节彩蛋逻辑），多张图片不触发复活节彩蛋
  5. **i18n 字符串**（`locales/zh.json`, `locales/ja.json`, `locales/en.json`）：
     - `home.scan.processingMulti`: "处理中 {current}/{total}" / "Processing {current}/{total}" / "処理中 {current}/{total}"
     - `home.scan.doneSummary`: "完成：成功 {ok}，失败 {fail}" / "Done: {ok} succeeded, {fail} failed" / "完了：成功 {ok}、失敗 {fail}"
     - `home.scan.confirmTitleMultiple`: "确认识别这 {count} 张小票？" / "Recognize these {count} receipts?" / "この {count} 枚の画像で認識しますか？"
     - `home.scan.images`: "张图片" / "images" / "枚の画像"
- **验收步骤**：
  1. **多选功能**：
     - 点击「扫描小票」→ 选择「从相册选择」
     - 在相册中选择多张图片（iOS 支持多选）
     - 确认对话框应显示 "确认识别这 N 张小票？"
  2. **顺序处理**：
     - 确认后，按钮应显示 "处理中 1/N"、"处理中 2/N" 等进度
     - 每张图片应顺序处理（不是并行）
     - 处理过程中按钮应禁用
  3. **结果验证**：
     - 所有图片处理完成后，应显示摘要 Alert（如 "完成：成功 3，失败 1"）
     - 进入「历史」页面，应看到所有成功处理的收据（每张图片对应一条记录）
     - 如果某张图片失败，其他图片仍应成功保存
  4. **单张图片流程**（确保未破坏）：
     - 选择单张图片时，仍使用原有流程（包含复活节彩蛋）
     - 相机拍照仍为单张处理

SQLite 迁移修复（transaction_at 列）：
- **问题**：
  - 真机报错：`no such column: transaction_at`
  - `listReceipts`/`getReceipt` 等 SQL 已引用 `transaction_at`，但迁移未生效或执行顺序不对
  - 查询可能在迁移完成之前就执行了
- **修复**（`lib/db.ts`）：
  1. **创建 `ensureSchema()` 函数**：
     - 专门确保 `receipts` 表的 `transaction_at` 列存在
     - 使用 `PRAGMA table_info(receipts)` 检查列是否存在
     - 如果不存在，执行 `ALTER TABLE receipts ADD COLUMN transaction_at INTEGER`
     - 创建索引：`CREATE INDEX IF NOT EXISTS idx_receipts_transaction_at ON receipts(transaction_at ASC)`
     - 幂等设计：可以安全地多次调用，使用 `_schemaEnsured` 标志和 `_schemaEnsurePromise` 防止并发重复执行
     - 错误处理：捕获并发情况下的 "duplicate column" 错误并忽略
  2. **在所有查询 receipts 之前调用 `ensureSchema()`**：
     - `listReceipts()`: 在查询前调用 `await ensureSchema()`
     - `getReceipt()`: 在查询前调用 `await ensureSchema()`
     - `saveReceipt()`: 在插入前调用 `await ensureSchema()`
  3. **执行顺序保证**：
     - 先调用 `await initIfNeeded()` 确保数据库已初始化
     - 再调用 `await ensureSchema()` 确保 schema 完整
     - 最后执行查询/插入操作
- **技术细节**：
  - `ensureSchema()` 使用单例模式，确保只执行一次迁移
  - 如果迁移失败，重置状态允许重试
  - 开发模式下记录迁移日志
- **验收步骤**：
  1. **真机测试**：
     - 在真机上启动应用（如果有旧数据库，应该自动迁移）
     - 进入 History 页面，应该能正常加载，不再出现 `no such column: transaction_at` 错误
     - 进入 Home 页面，应该能正常加载收据列表
     - 扫描并保存一张新小票，应该能正常保存
  2. **验证迁移**：
     - 在开发模式下，控制台应该看到 `[DB] Added transaction_at column to receipts table` 日志（仅第一次）
     - 检查数据库，`receipts` 表应该包含 `transaction_at` 列
     - 旧数据应该能正常查询（`transaction_at` 为 NULL，查询时使用 `COALESCE(transaction_at, created_at)`）
  3. **验证向后兼容**：
     - 旧数据（没有 `transaction_at`）应该能正常显示
     - 新数据（有 `transaction_at`）应该使用 `transaction_at` 排序
  4. **验证幂等性**：
     - 多次调用 `ensureSchema()` 不应该报错
     - 不应该重复添加列或索引

反馈提交修复（上线标准）：
- **问题**：
  - App 端日志显示 "Submission successful"，但 Supabase function Logs 无 invocation
  - 邮箱未收到反馈
  - 存在"未命中函数 / 或误判成功"的问题
- **修复**（`lib/feedbackService.ts`、`app/(tabs)/feedback.tsx`）：
  1. **统一 URL 与 headers**（A）：
     - URL 必须为 `${SUPABASE_URL}/functions/v1/send-feedback`
     - headers 必须包含：
       - `Authorization: Bearer ${SUPABASE_ANON_KEY}`
       - `apikey: ${SUPABASE_ANON_KEY}`
       - `Content-Type: application/json`
       - `x-device-id: deviceId`
       - `x-client: app`（新增）
       - `x-request-id: ${Date.now()}-${Math.random().toString(16).slice(2)}`（新增，用于可观测性）
  2. **严格成功判定**（B）：
     - fetch 后先读取 `status` 和 `text`
     - 如果 `!response.ok` -> throw，错误信息包含 status 与 text 前 300 字
     - `text` 为空 -> throw（不能当成功）
     - JSON parse 失败 -> throw
     - 仅当 `json.success === true` 才算成功；否则 throw（把 json 原样附带在错误里，DEV 下）
     - 不允许使用 `ok` 字段，必须使用 `success` 字段（与 Dashboard Test 保持一致）
  3. **DEV 可观测日志**（C）：
     - 在 `__DEV__` 下输出一次性日志：
       - `[Feedback] POST {url}`
       - `[Feedback] status=xxx`
       - `[Feedback] body=...(截断 300)`
     - 不在生产环境打印 body
  4. **UI 行为**（D）：
     - 提交中按钮禁用 + loading（已实现）
     - 只有在严格成功判定通过后才显示 "已提交/成功"
     - 失败显示 Alert：标题"提交失败"，内容为简短可读原因（网络/服务器/解析/未配置）
     - 失败时不清空输入（用户可以重试）
- **验收标准**（E）：
  1. **真机提交一次后，Supabase Logs（send-feedback）出现 invocation**：
     - 在 Supabase Dashboard -> Edge Functions -> send-feedback -> Logs
     - 应该能看到一次 invocation，包含 `x-request-id` header
     - 如果看不到 invocation，说明请求未到达 Edge Function
  2. **App 端能看到 status 与 body（DEV 下）**：
     - 在开发模式下，控制台应该看到：
       - `[Feedback] POST https://xxx.supabase.co/functions/v1/send-feedback`
       - `[Feedback] status=200`
       - `[Feedback] body={"success":true,"resend":{"id":"xxx"}}`
     - 如果 status 不是 200，应该看到错误日志
  3. **邮箱能收到反馈；若未收到，也必须在 App 明确提示**：
     - 如果 Edge Function 返回 `{success: true}`，App 应该显示"已提交"
     - 如果 Edge Function 返回 `{success: false}` 或没有 `success` 字段，App 应该显示"提交失败（服务器未确认成功）"
     - 不能默默成功（即使 status 200 但 success !== true 也要报错）
  4. **验证严格成功判定**：
     - 模拟 Edge Function 返回 `{success: false}` -> App 应该显示失败
     - 模拟 Edge Function 返回空响应 -> App 应该显示失败
     - 模拟 Edge Function 返回非 JSON -> App 应该显示失败
     - 模拟 Edge Function 返回 `{ok: true}`（但没有 success）-> App 应该显示失败
