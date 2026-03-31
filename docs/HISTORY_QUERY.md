# 历史页查询边界说明

基于当前代码事实，便于后续做搜索/分页时从正确层级接入。

## 当前加载入口

- **页面**：`app/(tabs)/history/index.tsx`
- **入口**：组件内 `load` 回调（`useCallback`），在 `useEffect` 与 `useFocusEffect` 中调用。
- **实际调用**：`listReceiptsForList(200)` 或 `listReceiptsForList({ limit: 200 })`（`lib/db.ts`）。

没有独立的 `useHistoryReceipts` 或类似 hook，加载逻辑直接写在 History 页面内。

## 查询接口：listReceiptsForList(options?)

- **签名**：`listReceiptsForList(options?: ListReceiptsOptions | number): Promise<ReceiptListRow[]>`
- **兼容**：传入数字时视为 `{ limit: number }`，与旧用法兼容。

### 已生效的字段

| 字段     | 类型              | 说明 |
|----------|-------------------|------|
| `limit`  | number (默认 200) | 条数上限，内部限制在 1..500 |
| `offset` | number (默认 0)   | 分页偏移，用于 OFFSET |
| `sortBy` | `'date'` \| `'total'` | `date`：按时间倒序（默认）；`total`：按金额倒序，再按时间 |

### 已生效但尚未接 UI 的字段

| 字段          | 说明 |
|---------------|------|
| `searchQuery` | 关键词/商户/备注过滤，底层在 DB/query 层通过 merchant_raw/merchant_normalized/note 的 LIKE 实现，当前页面尚未提供搜索 UI |

## searchQuery 当前的状态

- 数据层：`listReceiptsForList` 与 `receiptListQuery` 已根据 `searchQuery` 拼 WHERE 条件（merchant_raw/merchant_normalized/note LIKE）。
- 页面层：History 目前仍调用 `listReceiptsForList({ limit: 200 })`，未传入 searchQuery，也没有搜索框或筛选 UI。

## 下一阶段做搜索/分页 UI 时的接入建议

1. **数据层**：已支持 `limit`、`offset`、`sortBy`；搜索需在 `listReceiptsForList` 内实现 `searchQuery` 的 WHERE 条件。
2. **Hook 层**（可选）：新增 `useHistoryReceipts(options)`，内部调用 `listReceiptsForList(options)`，返回 `{ rows, loading, error, refresh }`。History 页可改为消费该 hook。
3. **页面层**：搜索框/排序/分页控件只改传入的 options，不直接拼 SQL。

这样「已生效的 limit/offset/sortBy」与「预留的 searchQuery」边界清晰，后续改动集中在 DB 与可选 hook。
