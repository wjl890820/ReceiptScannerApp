/**
 * Phase 2 deep offline regression harness runner.
 * OFFLINE / DETERMINISTIC / NO DB MUTATION / NO OCR / NO AI / NO NETWORK.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { buildPurchaseEventDatesFromRows } from '../repeatProductProfile';
import { calculateStats } from '../statsCalculator';
import { isV1SupportedReceipt } from '../merchantType';
import { buildHistoricalIndexFromEnvelope } from './buildHistoricalIndex';
import { collapseLogicalPurchases } from './collapseLogicalPurchases';
import {
  DEEP_REGRESSION_HARNESS_VERSION,
  type DeepPhysicalGroupConsumerAudit,
  type DeepRegressionReport,
} from './deepTypes';
import { loadExportEnvelope } from './parseExport';
import { reportPhysicalDuplicateGroups } from './projectCrossReceipt';
import { replayPriceHistory } from './replayPriceHistory';
import { replayRepeatProfiles } from './replayRepeat';
import { loadManifestsFromDir } from './runHarness';

export type RunDeepHarnessOptions = {
  exportPath: string;
  manifestDir?: string;
  gitHead?: string | null;
};

function tryGitHead(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Guard: refuse if a live Supabase JS client module is in the require graph.
 * lib/supabaseClient.ts may load transitively but must resolve to the CLI stub.
 */
export function assertDeepRunnerSafetyTripwire(): void {
  const keys = Object.keys(require.cache ?? {});
  const liveSupabase = keys.find(
    (k) =>
      k.includes(`${require('path').sep}node_modules${require('path').sep}@supabase${require('path').sep}supabase-js`) ||
      k.includes('/node_modules/@supabase/supabase-js')
  );
  if (liveSupabase) {
    throw new Error(
      `deep_runner_safety_tripwire: live @supabase/supabase-js loaded: ${liveSupabase}`
    );
  }
}

function finitePositiveQty(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

export function runDeepRegressionHarness(
  options: RunDeepHarnessOptions
): DeepRegressionReport {
  const started = Date.now();
  assertDeepRunnerSafetyTripwire();

  const exportAbs = path.resolve(options.exportPath);
  const rawText = fs.readFileSync(exportAbs, 'utf8');
  const envelope = loadExportEnvelope(JSON.parse(rawText));

  const defaultManifestDir = path.join(
    process.cwd(),
    'fixtures',
    'regression',
    'manifests'
  );
  const manifests = loadManifestsFromDir(
    options.manifestDir
      ? path.resolve(options.manifestDir)
      : defaultManifestDir
  );

  const historical = buildHistoricalIndexFromEnvelope(envelope);
  const collapse = collapseLogicalPurchases({
    rawReceiptRows: historical.rawReceiptRows,
    rawItemRows: historical.rawItemRows,
    rawPriceHistoryRows: historical.rawPriceHistoryRows,
  });

  const includedSet = new Set(collapse.includedReceiptIds);
  const excludedSet = new Set(collapse.excludedDuplicateReceiptIds);
  const occurrenceIndex = collapse.purchaseOccurrenceIndex;

  const physicalDuplicateGroups = reportPhysicalDuplicateGroups({
    manifests,
    loadedRows: historical.loadedRows,
    includedReceiptIds: includedSet,
    excludedDuplicateReceiptIds: excludedSet,
  });

  const repeat = replayRepeatProfiles({
    analyticsReceipts: collapse.selection.analyticsReceipts,
    productRows: collapse.analyticsItemRows,
    purchaseOccurrenceIndex: occurrenceIndex,
  });

  const pph = replayPriceHistory({
    analyticsPriceHistoryRows: collapse.analyticsPriceHistoryRows,
    purchaseOccurrenceIndex: occurrenceIndex,
  });

  const visitStats = calculateStats(
    collapse.occurrenceRepresentativeReceipts,
    'all',
    0
  );

  // Invariant: ready ⇒ comparablePoints >= 2
  const readyRequiresTwoComparablePoints = pph.targets.every(
    (t) => t.status !== 'ready' || t.comparablePoints >= 2
  );

  let rescansDoNotInflateRepeatOccurrences = true;
  let rescansDoNotInflateRepeatQuantity = true;
  let rescansDoNotInflateComparablePoints = true;
  let rescansDoNotInflatePphGrossOrQuantity = true;

  const physicalGroupsCollapsed: DeepPhysicalGroupConsumerAudit[] =
    physicalDuplicateGroups.map((g) => {
      const survivors = g.survivingReceiptIds;
      const survivorSet = new Set(survivors);
      const occurrenceIds = [
        ...new Set(
          survivors.map(
            (id) => occurrenceIndex.occurrenceIdByReceiptId.get(id) ?? id
          )
        ),
      ].sort((a, b) => a.localeCompare(b));
      const occurrenceMapCollapsed =
        survivors.length <= 1 || occurrenceIds.length <= 1;
      const productionCanonicalOccurrences = Math.max(
        1,
        occurrenceIds.length || survivors.length || 1
      );

      let physicalTruthSplitStatus: import('./deepTypes').PhysicalTruthSplitStatus =
        'aligned';
      if (g.collapseDiagnostic === 'unmatched') {
        physicalTruthSplitStatus = 'unmatched';
      } else if (survivors.length <= 1 && g.storedRows <= 1) {
        physicalTruthSplitStatus = 'single_row';
      } else if (!occurrenceMapCollapsed) {
        physicalTruthSplitStatus = 'unresolved_without_durable_provenance';
      }

      const unresolvedHistoricalDuplicate =
        physicalTruthSplitStatus === 'unresolved_without_durable_provenance'
          ? ('known_historical_duplicate_unresolved' as const)
          : null;

      // --- Repeat / PPH inflation only for *proven* single-occurrence cohorts ---
      let repeatOccurrenceContributionMax: number | null = null;
      let repeatQuantityContributionMax: number | null = null;
      let pphComparableOccurrenceContributionMax: number | null = null;
      let pphGrossInflationDetected = false;
      let pphQuantityInflationDetected = false;

      if (survivors.length > 1 && occurrenceMapCollapsed) {
        const survivorItemRows = collapse.analyticsItemRows.filter((row) =>
          survivorSet.has(row.receiptId)
        );
        const byIdentity = new Map<string, typeof survivorItemRows>();
        for (const row of survivorItemRows) {
          const key =
            (row as { merchantProductId?: string | null }).merchantProductId ||
            row.displayName ||
            `${row.receiptId}:${row.sourceIndex}`;
          const list = byIdentity.get(key) ?? [];
          list.push(row);
          byIdentity.set(key, list);
        }
        let maxOcc = 0;
        let maxQty = 0;
        for (const rows of byIdentity.values()) {
          const timeline = buildPurchaseEventDatesFromRows(
            rows.map((r) => ({
              receiptId: r.receiptId,
              occurredAt: r.occurredAt,
            })),
            {
              purchaseOccurrenceIdByReceiptId:
                occurrenceIndex.occurrenceIdByReceiptId,
              representativeReceiptIdByReceiptId:
                occurrenceIndex.representativeReceiptIdByReceiptId,
            }
          );
          maxOcc = Math.max(maxOcc, timeline.purchaseOccurrenceCount);
          let qty = 0;
          for (const row of rows) {
            const rep =
              occurrenceIndex.representativeReceiptIdByReceiptId.get(
                row.receiptId
              ) ?? row.receiptId;
            if (rep !== row.receiptId) continue;
            const q =
              finitePositiveQty(row.purchaseQuantity) ??
              finitePositiveQty((row as { quantity?: number }).quantity);
            if (q != null) qty += q;
          }
          maxQty = Math.max(maxQty, qty);
        }
        repeatOccurrenceContributionMax = maxOcc;
        repeatQuantityContributionMax = maxQty;
        if (maxOcc > 1) {
          rescansDoNotInflateRepeatOccurrences = false;
          rescansDoNotInflateRepeatQuantity = false;
        }

        let maxPoints = 0;
        for (const target of pph.targets) {
          const pointsFromSurvivors = (target.points ?? []).filter((p) =>
            survivorSet.has(p.receiptId)
          );
          if (pointsFromSurvivors.length === 0) continue;
          maxPoints = Math.max(maxPoints, pointsFromSurvivors.length);
          for (const point of pointsFromSurvivors) {
            if (
              pointsFromSurvivors.length === 1 &&
              survivors.length >= 2 &&
              point.purchaseQuantity >= survivors.length &&
              Number.isFinite(point.grossLineAmount) &&
              Number.isFinite(point.priceValue) &&
              Math.round(point.grossLineAmount) ===
                Math.round(point.priceValue * point.purchaseQuantity) &&
              Math.round(point.purchaseQuantity) === survivors.length
            ) {
              pphQuantityInflationDetected = true;
              pphGrossInflationDetected = true;
            }
          }
          if (pointsFromSurvivors.length > 1) {
            pphComparableOccurrenceContributionMax = Math.max(
              pphComparableOccurrenceContributionMax ?? 0,
              pointsFromSurvivors.length
            );
            rescansDoNotInflateComparablePoints = false;
          }
        }
        if (pphComparableOccurrenceContributionMax == null) {
          pphComparableOccurrenceContributionMax = maxPoints;
        }
        if (maxPoints > 1) {
          rescansDoNotInflateComparablePoints = false;
        }
        if (pphGrossInflationDetected || pphQuantityInflationDetected) {
          rescansDoNotInflatePphGrossOrQuantity = false;
        }
      } else if (survivors.length > 1 && !occurrenceMapCollapsed) {
        // Split without durable provenance: report contribution maxima for
        // diagnostics only — do not fail production safety invariants.
        const survivorItemRows = collapse.analyticsItemRows.filter((row) =>
          survivorSet.has(row.receiptId)
        );
        const byIdentity = new Map<string, typeof survivorItemRows>();
        for (const row of survivorItemRows) {
          const key =
            (row as { merchantProductId?: string | null }).merchantProductId ||
            row.displayName ||
            `${row.receiptId}:${row.sourceIndex}`;
          const list = byIdentity.get(key) ?? [];
          list.push(row);
          byIdentity.set(key, list);
        }
        let maxOcc = 0;
        let maxQty = 0;
        for (const rows of byIdentity.values()) {
          const timeline = buildPurchaseEventDatesFromRows(
            rows.map((r) => ({
              receiptId: r.receiptId,
              occurredAt: r.occurredAt,
            })),
            {
              purchaseOccurrenceIdByReceiptId:
                occurrenceIndex.occurrenceIdByReceiptId,
              representativeReceiptIdByReceiptId:
                occurrenceIndex.representativeReceiptIdByReceiptId,
            }
          );
          maxOcc = Math.max(maxOcc, timeline.purchaseOccurrenceCount);
          let qty = 0;
          for (const row of rows) {
            const rep =
              occurrenceIndex.representativeReceiptIdByReceiptId.get(
                row.receiptId
              ) ?? row.receiptId;
            if (rep !== row.receiptId) continue;
            const q =
              finitePositiveQty(row.purchaseQuantity) ??
              finitePositiveQty((row as { quantity?: number }).quantity);
            if (q != null) qty += q;
          }
          maxQty = Math.max(maxQty, qty);
        }
        repeatOccurrenceContributionMax = maxOcc;
        repeatQuantityContributionMax = maxQty;
        let maxPoints = 0;
        for (const target of pph.targets) {
          const pointsFromSurvivors = (target.points ?? []).filter((p) =>
            survivorSet.has(p.receiptId)
          );
          if (pointsFromSurvivors.length === 0) continue;
          maxPoints = Math.max(maxPoints, pointsFromSurvivors.length);
        }
        pphComparableOccurrenceContributionMax = maxPoints;
      }

      const repReceipts = collapse.occurrenceRepresentativeReceipts.filter(
        (r) => {
          const occ =
            occurrenceIndex.occurrenceIdByReceiptId.get(r.id) ?? r.id;
          return occurrenceIds.includes(occ);
        }
      );
      const supportedReps = repReceipts.filter(isV1SupportedReceipt);
      const visitCountOnRepresentatives =
        survivors.length > 0 ? supportedReps.length : null;
      const spendOnRepresentatives =
        survivors.length > 0
          ? supportedReps.reduce((sum, r) => sum + (r.total || 0), 0)
          : null;

      const productionConsumerSafe =
        !pphGrossInflationDetected &&
        !pphQuantityInflationDetected &&
        (occurrenceMapCollapsed
          ? (repeatOccurrenceContributionMax == null ||
              repeatOccurrenceContributionMax <= 1) &&
            (pphComparableOccurrenceContributionMax == null ||
              pphComparableOccurrenceContributionMax <= 1)
          : true);

      return {
        receiptNo: g.receiptNo,
        diagnostic: g.collapseDiagnostic,
        humanTruthPhysicalPurchases: 1 as const,
        storedRows: g.storedRows,
        analyticsRetainedReceipts: g.analyticsIncludedRows,
        productionCanonicalOccurrences,
        canonicalOccurrenceIdsAmongSurvivors: occurrenceIds,
        occurrenceMapCollapsed,
        physicalTruthSplitDiagnostic: { status: physicalTruthSplitStatus },
        unresolvedHistoricalDuplicate,
        repeatOccurrenceContributionMax,
        repeatQuantityContributionMax,
        pphComparableOccurrenceContributionMax,
        pphGrossInflationDetected,
        pphQuantityInflationDetected,
        visitCountOnRepresentatives,
        spendOnRepresentatives,
        productionConsumerSafe,
      };
    });

  const unresolvedHistoricalDuplicateGroups = physicalGroupsCollapsed.filter(
    (a) => a.unresolvedHistoricalDuplicate != null
  ).length;

  const wallClockMs = Date.now() - started;

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      exportPathBasename: path.basename(exportAbs),
      harnessVersion: DEEP_REGRESSION_HARNESS_VERSION,
      gitHead:
        options.gitHead !== undefined ? options.gitHead : tryGitHead(),
      wallClockMs,
    },
    observedHistory: { status: 'not_available_phase2_v1' },
    observedHistoryStatus: 'not_comparable_phase2_v1',
    deep: {
      inputMode: 'current_projection',
      crossReceipt: {
        storedReceiptRows: envelope.receipts.length,
        usableReceiptRows: historical.usableReceiptCount,
        skippedReceiptRows: historical.skippedReceiptIds.length,
        analyticsRetainedReceipts: collapse.analyticsRetainedReceiptCount,
        analyticsLogicalPurchases: collapse.analyticsRetainedReceiptCount,
        canonicalPurchaseOccurrences: collapse.canonicalPurchaseOccurrenceCount,
        knownPhysicalPurchaseGroups: physicalDuplicateGroups.length,
        unresolvedHistoricalDuplicateGroups,
        duplicateRowsExcluded: collapse.duplicateRowCount,
        rawItemObservations: historical.rawItemRows.length,
        analyticsItemObservations: collapse.analyticsItemRows.length,
        duplicateGroupCount: collapse.duplicateGroups.length,
      },
      visitSpend: {
        analyticsRetainedReceiptCount: collapse.analyticsRetainedReceiptCount,
        occurrenceRepresentativeReceiptCount:
          collapse.occurrenceRepresentativeReceipts.length,
        supportedVisitCount: visitStats.supportedReceiptCount,
        supportedSpend: visitStats.supportedSpend,
      },
      physicalDuplicateGroups,
      repeat: {
        profileCount: repeat.profileCount,
        merchantProductProfiles: repeat.merchantProductProfiles,
        personalProductProfiles: repeat.personalProductProfiles,
        occurrenceDistribution: repeat.occurrenceDistribution,
        profiles: repeat.profiles,
        personalProduct: repeat.personalProduct,
      },
      pph: {
        targetCount: pph.targetCount,
        ready: pph.ready,
        notEnoughPoints: pph.notEnoughPoints,
        otherStatuses: pph.otherStatuses,
        comparablePointDistribution: pph.comparablePointDistribution,
        comparabilityLevelCounts: pph.comparabilityLevelCounts,
        rejectionReasonCounts: pph.rejectionReasonCounts,
        targets: pph.targets,
        personalProduct: pph.personalProduct,
      },
      deepConsumers: {
        repeat: 'run',
        pph: 'run',
        visitSpend: 'run',
      },
      invariants: {
        readyRequiresTwoComparablePoints,
        rescansDoNotInflateRepeatOccurrences,
        rescansDoNotInflateRepeatQuantity,
        rescansDoNotInflateComparablePoints,
        rescansDoNotInflatePphGrossOrQuantity,
        physicalGroupsCollapsed,
      },
    },
  };
}
