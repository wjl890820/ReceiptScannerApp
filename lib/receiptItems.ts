/**
 * 统一 receipt 商品行读取入口。
 *
 * 规则（V1 数据一致性）：
 * 1. user_items_json 存在且可解析为合法 array → 使用 user_items_json
 * 2. 否则 → analysis_json.items
 * 3. 两者都失败 → []
 *
 * 任意 JSON parse error 均 degrade gracefully，不 throw。
 */

export type ReceiptItemSource = {
  analysis_json?: string | null;
  user_items_json?: string | null;
};

function parseJsonArray(raw: string | null | undefined): unknown[] | null {
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readAnalysisItems(analysisJson: string | null | undefined): unknown[] {
  if (analysisJson == null || typeof analysisJson !== 'string' || !analysisJson.trim()) {
    return [];
  }
  try {
    const obj = JSON.parse(analysisJson);
    if (!obj || typeof obj !== 'object') return [];
    const items = (obj as { items?: unknown }).items;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/**
 * 读取小票商品行（用户编辑优先）。
 */
export function getReceiptItems(receipt: ReceiptItemSource): unknown[] {
  const userItems = parseJsonArray(receipt.user_items_json);
  if (userItems !== null) return userItems;
  return readAnalysisItems(receipt.analysis_json);
}
