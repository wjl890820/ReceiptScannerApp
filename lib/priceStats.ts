import { listReceipts, type ReceiptRow } from './db';
import { getReceiptItems } from './receiptItems';

export type CanonicalPriceStat = {
  canonical_name: string;
  avg_price: number;
  min_price: number;
  max_price: number;
  last_price: number;
  count: number;
};

function toNum(v: any): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getCanonicalNamePriceStats(limit = 50): Promise<CanonicalPriceStat[]> {
  // Note: items are stored inside receipts.analysis_json / user_items_json, not in a separate SQL table.
  const receipts: ReceiptRow[] = await listReceipts(2000);
  const map = new Map<string, { sum: number; count: number; min: number; max: number; lastAt: number; lastPrice: number }>();

  for (const r of receipts) {
    const items = getReceiptItems(r) as any[];
    if (!Array.isArray(items) || items.length === 0) continue;

    const at = (r.transaction_at ?? (r as any).scanned_at ?? r.created_at) || r.created_at;
    for (const it of items) {
      const canon = String((it as any)?.canonical_name || '').trim();
      if (!canon) continue;
      const unit = toNum((it as any)?.unit_price);
      const line = toNum((it as any)?.line_total ?? (it as any)?.lineTotal);
      const price = unit && unit > 0 ? unit : line && line > 0 ? line : null;
      if (!price || price <= 0) continue;

      const cur = map.get(canon);
      if (!cur) {
        map.set(canon, { sum: price, count: 1, min: price, max: price, lastAt: at, lastPrice: price });
      } else {
        cur.sum += price;
        cur.count += 1;
        cur.min = Math.min(cur.min, price);
        cur.max = Math.max(cur.max, price);
        if (at >= cur.lastAt) {
          cur.lastAt = at;
          cur.lastPrice = price;
        }
      }
    }
  }

  const rows: CanonicalPriceStat[] = Array.from(map.entries()).map(([canonical_name, v]) => ({
    canonical_name,
    avg_price: v.count > 0 ? v.sum / v.count : 0,
    min_price: v.min,
    max_price: v.max,
    last_price: v.lastPrice,
    count: v.count,
  }));

  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, limit);
}

