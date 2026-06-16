# i18n 清理说明（本轮）

## 已删除的 key（已确认无引用）

- **home.scan.rateLimit**、**home.scan.payloadTooLarge**、**home.scan.networkError**、**home.scan.serverError**  
  扫描错误文案已统一使用顶层 **ocr.***（ocr.rateLimit、ocr.payloadTooLarge 等），由 `lib/scanError.ts` 的 `getScanErrorMessage()` 使用。上述 4 个 key 在 zh / en / ja 中已删除，避免重复维护。

## 暂时保留

- **home.scan.errorMessage**：保留，作为通用“请稍后重试”类文案，部分场景可能仍引用；若后续确认无引用可再删。
- 其他 **home.scan.***（如 button、title、confirmTitle 等）均仍在使用，未动。

## 本轮新增与收口

- **history.list.title**、**history.list.subtitle**、**history.list.empty**、**history.list.noCategoryInfo**：历史列表页标题、副标题、空状态、行内“未找到分类信息”已收口到 i18n。  
- 历史列表行内“税”使用已有 **history.detail.taxLabel**，未新增 key。
