// scripts/reclassify_receipts.js
// One-off migration: re-run item categorization for existing receipts whose items lack category.
//
// Usage:
//   node scripts/reclassify_receipts.js
//
// Notes:
// - Runs in Node, uses the same code paths as the app (receiptEnricher + db.updateReceipt).
// - Only updates receipts where analysis_json.items exist and at least one item has empty/missing category.
// - Does NOT touch user_items_json (user edits).
// - Prints before/after counts for verification.

/* eslint-disable no-console */

async function main() {
  const { listReceipts, updateReceipt } = await import('../lib/db.ts');
  const { applyCategoriesWithLearning } = await import('../lib/receiptEnricher.ts');

  const receipts = await listReceipts(500);
  console.log('[reclassify] loaded receipts:', receipts.length);

  let touched = 0;
  let skippedNoItems = 0;
  let skippedAlreadyCategorized = 0;
  let failed = 0;

  for (const r of receipts) {
    // Skip user-edited receipts; don't override user_items_json based display.
    if (r.user_edited === 1 && r.user_items_json) continue;

    let analysis;
    try {
      analysis = JSON.parse(r.analysis_json || '{}');
    } catch {
      continue;
    }

    const items = Array.isArray(analysis?.items) ? analysis.items : [];
    if (items.length === 0) {
      skippedNoItems++;
      continue;
    }

    const missingBefore = items.filter((it) => !it?.category || String(it.category).trim() === '').length;
    if (missingBefore === 0) {
      skippedAlreadyCategorized++;
      continue;
    }

    try {
      const enriched = await applyCategoriesWithLearning(analysis);
      const afterItems = Array.isArray(enriched?.items) ? enriched.items : [];
      const missingAfter = afterItems.filter((it) => !it?.category || String(it.category).trim() === '').length;

      await updateReceipt({ id: r.id, analysis: enriched });
      touched++;
      console.log('[reclassify] updated', r.id.slice(0, 8), { items: items.length, missingBefore, missingAfter });
    } catch (e) {
      failed++;
      console.warn('[reclassify] failed', r.id.slice(0, 8), e?.message || e);
    }
  }

  console.log('[reclassify] done', {
    touched,
    skippedNoItems,
    skippedAlreadyCategorized,
    failed,
  });
}

main().catch((e) => {
  console.error('[reclassify] fatal', e);
  process.exitCode = 1;
});

