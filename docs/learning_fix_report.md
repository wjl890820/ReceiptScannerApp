# 学习链路修复说明（审核保存 → 下次识别命中）

## 问题表现

- 用户在审核页修改商品分类后，`product_name_alias`、`product_dictionary`、`learnFromUserEdit` / `item_category_mapping` 侧表现为「未学习」或学了也不命中。
- 复盘中 `manualAliasRowCount = 0` 等统计反映人工学习未落库或未参与命中。

## 根因结论

### 1. 归一化键不一致（主因）

`learnFromUserEdit` 原先通过 `normalizeProductName` 得到映射键，而 `applyCategoriesWithLearning` / `classifyItem` 使用 `normalizeReceiptItemName` 得到的 `normalized_name` 调用 `getLearnedCategory`。两条路径若不一致，则 `item_category_mapping` 写入的 `normalized_name` 与查询键不同，表现为「学了但永远对不上」。

**修复**：`learnFromUserEdit` 统一使用 `normalizeReceiptItemName(itemName).normalized_name`（再 `trim().toLowerCase()`）作为 `learnCategoryMapping` 的键，与分类管线完全一致。

### 2. 仅改分类时 `categoryChanged` 恒为 false

`receiptReviewLearning` 中曾使用 `snapCatRaw.length > 0 && catRaw !== snapCatRaw`。当 OCR/初识结果里分类为空字符串时，用户只改分类也不会进入学习分支。

**修复**：改为 `catRaw !== snapCatRaw`，与快照是否有分类无关。

### 3. 商户 hint 写入与查询不一致

`learnCategoryMapping` 曾对 `merchant_hint` 使用 `trim().toLowerCase()`，而 `getLearnedCategory` / `lookupProductNameAlias` 使用 `normalizeMerchantName`。同一商户字符串可能生成不同库键，导致带商户优先查询 miss。

**修复**：`learnCategoryMapping` 对非空 `merchant_hint` 使用 `normalizeMerchantName`，与读取侧一致。

### 4. 仅改分类时未写「自指」别名（与历史详情对齐）

历史详情保存商品编辑时，在写 dictionary 后会 `upsertProductNameAlias`（`alias_normalized` 为收据归一化名），使 `applyCategoriesWithLearning` 中别名优先路径能命中。审核页「仅分类」分支此前未写该别名，别名统计与命中机会偏少。

**修复**：在 `categoryChanged` 分支中补充与历史页一致的 `upsertProductNameAlias`（`alias_normalized = finalNorm`，`canonical_name = finalName`）。

### 5. 调用链与 await（核查结果）

`app/scan-review/[draftId].tsx` 在保存成功后 **`await applyReviewCorrectionsToLearning(...)`**，并非因未 await 而跳过。本次在 `receiptReviewLearning` 中将静默 `catch` 改为 `logger.warn`，避免真实错误被完全吞掉。

### 6. `learnFromUserEdit` 与商户

`learnFromUserEdit` 增加可选第三参 `merchantHintRaw`：始终写入 `merchant_hint = ''` 的通用映射；若传入商户，则再写入一条 `normalizeMerchantName(merchantHintRaw)` 的映射，与 `getLearnedCategory`「先商户后通用」的查询顺序一致。审核学习传入 `merchantRaw`；历史详情保存同样传入 `receipt.merchant_raw`。

## 涉及文件

| 文件 | 变更要点 |
|------|-----------|
| `lib/receiptEnricher.ts` | `learnFromUserEdit`：收据归一化键 + `learnCategoryMapping` + 可选商户双写 |
| `lib/categoryLearner.ts` | `learnCategoryMapping`：`merchant_hint` 用 `normalizeMerchantName` |
| `lib/receiptReviewLearning.ts` | `categoryChanged` 条件；分类分支补 alias；`learnFromUserEdit(..., merchantRaw)`；失败打日志 |
| `app/(tabs)/history/[id].tsx` | `learnFromUserEdit` 传入商户（与审核一致，非 UI 改动） |

## `product_dictionary` 是否参与分类

是。`lib/categoryClassifier.ts` 中 `classifyItem` 在 `getLearnedCategory` 之前调用 `lookupProductDictionary`，使用的键与收据项 `normalized_name` 一致。审核路径已用 `normalizeReceiptItemName(finalName).normalized_name` 写入 dictionary，与查询对齐。

## 建议验证步骤

1. 准备一张小票草稿，某行商品分类为空或错误。
2. 在审核页**只改分类**并保存。
3. 检查（调试或 DB 导出）：`item_category_mapping` 出现对应 `normalized_name`；`product_dictionary` 有行；`product_name_alias` 有 `source=manual` 的自指别名行（若此前为 0，此处应增长）。
4. 再扫一张含**同名或同归一化键**的商品小票，确认分类更易命中（先字典/别名，再 learned mapping）。

## 明确未改动的范围

- 未修改 OCR 与 UI 组件；仅数据学习与归一化/条件逻辑。
