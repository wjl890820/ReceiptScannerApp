/**
 * Compact terminal summary for Phase 2 deep regression.
 */

import type { DeepRegressionReport } from './deepTypes';

export function formatDeepConsoleSummary(report: DeepRegressionReport): string {
  const d = report.deep;
  const lines: string[] = [];
  lines.push('Meruno Deep Receipt Regression');
  lines.push('------------------------------');
  lines.push(`Stored receipt rows: ${d.crossReceipt.storedReceiptRows}`);
  lines.push(
    `Analytics retained receipts: ${d.crossReceipt.analyticsRetainedReceipts}`
  );
  lines.push(
    `Canonical purchase occurrences: ${d.crossReceipt.canonicalPurchaseOccurrences}`
  );
  lines.push(
    `Visit/spend representatives: ${d.visitSpend.occurrenceRepresentativeReceiptCount} visits=${d.visitSpend.supportedVisitCount} spend=¥${d.visitSpend.supportedSpend}`
  );
  lines.push(
    `Known physical groups: ${d.crossReceipt.knownPhysicalPurchaseGroups}; unresolved historical duplicates: ${d.crossReceipt.unresolvedHistoricalDuplicateGroups}`
  );
  lines.push(
    `Duplicate rows excluded: ${d.crossReceipt.duplicateRowsExcluded}`
  );
  lines.push(`Raw item observations: ${d.crossReceipt.rawItemObservations}`);
  lines.push(
    `Analytics observations: ${d.crossReceipt.analyticsItemObservations}`
  );
  lines.push(
    `Repeat profiles (≥2 occurrences): ${d.repeat.profileCount}`
  );
  lines.push(`PPH targets (comparison keys): ${d.pph.targetCount}`);
  lines.push(`Ready: ${d.pph.ready}`);
  lines.push(`Not enough points: ${d.pph.notEnoughPoints}`);
  lines.push('');
  lines.push('Top PPH rejection reasons (observation hits; may overlap):');
  const reasons = Object.entries(d.pph.rejectionReasonCounts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  if (reasons.length === 0) {
    lines.push('- none');
  } else {
    for (const [reason, count] of reasons.slice(0, 8)) {
      lines.push(`- ${reason}: ${count}`);
    }
  }
  lines.push('');
  lines.push('Known physical duplicate groups:');
  if (d.physicalDuplicateGroups.length === 0) {
    lines.push('- none matched');
  } else {
    const invByNo = new Map(
      d.invariants.physicalGroupsCollapsed.map((g) => [g.receiptNo, g])
    );
    for (const g of d.physicalDuplicateGroups) {
      const inv = invByNo.get(g.receiptNo);
      const occCount = inv?.productionCanonicalOccurrences ?? 0;
      const split = inv?.physicalTruthSplitDiagnostic.status;
      const tag = inv?.productionConsumerSafe
        ? split === 'unresolved_without_durable_provenance'
          ? 'prod-safe; truth-split unresolved'
          : g.collapsedToOneLogicalPurchase
            ? 'ok'
            : 'ok prod-safe'
        : 'FAIL production-unsafe';
      lines.push(
        `Receipt${String(g.receiptNo).padStart(3, '0')}: stored ${g.storedRows} → analytics ${g.analyticsIncludedRows} / prodOcc ${occCount} (${tag})`
      );
    }
  }
  lines.push('');
  lines.push(
    `invariants: ready≥2=${d.invariants.readyRequiresTwoComparablePoints} rescanOcc=${d.invariants.rescansDoNotInflateRepeatOccurrences} rescanQty=${d.invariants.rescansDoNotInflateRepeatQuantity} rescanPPH=${d.invariants.rescansDoNotInflateComparablePoints} rescanPphValue=${d.invariants.rescansDoNotInflatePphGrossOrQuantity}`
  );
  lines.push('');
  lines.push(
    `observedHistory: ${report.observedHistory.status}; wallClockMs=${report.metadata.wallClockMs}`
  );
  lines.push(
    `deepConsumers: repeat=${d.deepConsumers.repeat}, pph=${d.deepConsumers.pph}, visitSpend=${d.deepConsumers.visitSpend}`
  );
  if (!d.invariants.readyRequiresTwoComparablePoints) {
    lines.push('INVARIANT FAIL: ready with <2 comparable points');
  }
  return lines.join('\n');
}
