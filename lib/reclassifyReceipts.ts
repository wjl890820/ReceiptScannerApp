// One-off: re-run classification for stored receipts that still have missing item.category.

import { listReceipts, updateReceipt } from './db';
import { applyCategoriesWithLearning } from './receiptEnricher';

export type ReclassifyStats = {
  touched: number;
  skippedNoItems: number;
  skippedAlreadyCategorized: number;
  skippedUserEdited: number;
  failed: number;
};

export async function reclassifyReceiptsMissingCategories(receiptLimit = 500): Promise<ReclassifyStats> {
  const receipts = await listReceipts(receiptLimit);
  const stats: ReclassifyStats = {
    touched: 0,
    skippedNoItems: 0,
    skippedAlreadyCategorized: 0,
    skippedUserEdited: 0,
    failed: 0,
  };

  for (const r of receipts) {
    if (r.user_edited === 1 && r.user_items_json) {
      stats.skippedUserEdited++;
      continue;
    }
    let analysis: any;
    try {
      analysis = JSON.parse(r.analysis_json || '{}');
    } catch {
      continue;
    }
    const items: any[] = Array.isArray(analysis?.items) ? analysis.items : [];
    if (items.length === 0) {
      stats.skippedNoItems++;
      continue;
    }
    const missingBefore = items.filter((it) => !it?.category || String(it.category).trim() === '').length;
    if (missingBefore === 0) {
      stats.skippedAlreadyCategorized++;
      continue;
    }

    try {
      const enriched = await applyCategoriesWithLearning(analysis);
      const afterItems: any[] = Array.isArray(enriched?.items) ? enriched.items : [];
      const missingAfter = afterItems.filter((it) => !it?.category || String(it.category).trim() === '').length;
      await updateReceipt({ id: r.id, analysis: enriched });
      stats.touched++;
      if (__DEV__) {
        console.log('[Reclassify] updated', r.id.slice(0, 8), { items: items.length, missingBefore, missingAfter });
      }
    } catch (e: any) {
      stats.failed++;
      console.warn('[Reclassify] failed', r.id.slice(0, 8), e?.message || e);
    }
  }

  return stats;
}
