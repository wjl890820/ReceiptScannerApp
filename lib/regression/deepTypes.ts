/**
 * Phase 2 deep report types.
 */

import type { PphTargetReplayReport } from './replayPriceHistory';
import type { RepeatReplayProfileProjection } from './replayRepeat';

export const DEEP_REGRESSION_HARNESS_VERSION = '2.3.0-phase2-a-fix-r5';

export type PhysicalDuplicateCollapseDiagnostic =
  | 'collapsed_to_one'
  | 'partial_hc_collapse_expected'
  | 'single_stored_row'
  | 'unmatched';

export type PhysicalTruthSplitStatus =
  | 'aligned'
  | 'unresolved_without_durable_provenance'
  | 'single_row'
  | 'unmatched';

export type PhysicalDuplicateGroupReport = {
  receiptNo: number;
  storedRows: number;
  analyticsIncludedRows: number;
  analyticsExcludedRows: number;
  survivingReceiptIds: string[];
  excludedReceiptIds: string[];
  /**
   * True when HC retained exactly one analytics purchase among matched rows.
   * False may be EXPECTED production HC conservatism — see collapseDiagnostic.
   */
  collapsedToOneLogicalPurchase: boolean;
  matchedHistoricalRows: string[];
  collapseDiagnostic: PhysicalDuplicateCollapseDiagnostic;
};

/**
 * Production-safety audit for a known physical group.
 * Human-truth splits (missing durable provenance) are diagnostic only.
 */
export type DeepPhysicalGroupConsumerAudit = {
  receiptNo: number;
  diagnostic: PhysicalDuplicateCollapseDiagnostic;
  /** Human-truth: always 1 for a confirmed physical purchase group. */
  humanTruthPhysicalPurchases: 1;
  storedRows: number;
  analyticsRetainedReceipts: number;
  productionCanonicalOccurrences: number;
  canonicalOccurrenceIdsAmongSurvivors: string[];
  /**
   * True when analytics survivors map to ≤1 production occurrence.
   * False with unresolved provenance is a diagnostic, not an A-fail.
   */
  occurrenceMapCollapsed: boolean;
  physicalTruthSplitDiagnostic: {
    status: PhysicalTruthSplitStatus;
  };
  /** known_historical_duplicate_unresolved when production leaves them split. */
  unresolvedHistoricalDuplicate:
    | 'known_historical_duplicate_unresolved'
    | null;
  repeatOccurrenceContributionMax: number | null;
  repeatQuantityContributionMax: number | null;
  pphComparableOccurrenceContributionMax: number | null;
  /** True when a *proven* single occurrence still summed rescan gross/qty. */
  pphGrossInflationDetected: boolean;
  pphQuantityInflationDetected: boolean;
  visitCountOnRepresentatives: number | null;
  spendOnRepresentatives: number | null;
  /**
   * Production-safe: no value inflation inside a proven occurrence.
   * Human-truth split alone does not make this false.
   */
  productionConsumerSafe: boolean;
};

export type DeepRegressionReport = {
  metadata: {
    generatedAt: string;
    exportPathBasename: string;
    harnessVersion: string;
    gitHead: string | null;
    wallClockMs: number;
  };
  observedHistory: {
    status: 'not_available_phase2_v1';
  };
  observedHistoryStatus: 'not_comparable_phase2_v1';
  deep: {
    inputMode: 'current_projection';
    crossReceipt: {
      storedReceiptRows: number;
      usableReceiptRows: number;
      skippedReceiptRows: number;
      analyticsRetainedReceipts: number;
      /** @deprecated alias of analyticsRetainedReceipts */
      analyticsLogicalPurchases: number;
      canonicalPurchaseOccurrences: number;
      knownPhysicalPurchaseGroups: number;
      unresolvedHistoricalDuplicateGroups: number;
      duplicateRowsExcluded: number;
      rawItemObservations: number;
      analyticsItemObservations: number;
      duplicateGroupCount: number;
    };
    visitSpend: {
      analyticsRetainedReceiptCount: number;
      occurrenceRepresentativeReceiptCount: number;
      supportedVisitCount: number;
      supportedSpend: number;
    };
    physicalDuplicateGroups: PhysicalDuplicateGroupReport[];
    repeat: {
      profileCount: number;
      merchantProductProfiles: number;
      personalProductProfiles: number;
      occurrenceDistribution: Record<string, number>;
      profiles: RepeatReplayProfileProjection[];
      personalProduct: { status: 'disabled_offline_phase2_v1' };
    };
    pph: {
      targetCount: number;
      ready: number;
      notEnoughPoints: number;
      otherStatuses: Record<string, number>;
      comparablePointDistribution: Record<string, number>;
      comparabilityLevelCounts: Record<string, number>;
      rejectionReasonCounts: Record<string, number>;
      targets: PphTargetReplayReport[];
      personalProduct: { status: 'unsupported_offline_phase2_v1' };
    };
    deepConsumers: {
      repeat: 'run';
      pph: 'run';
      visitSpend: 'run';
    };
    invariants: {
      readyRequiresTwoComparablePoints: boolean;
      /**
       * Within each *proven* single occurrence that retains multiple analytics
       * rows, Repeat does not count >1 occurrence / inflate quantity.
       * Human-truth splits are excluded (diagnostic only).
       */
      rescansDoNotInflateRepeatOccurrences: boolean;
      rescansDoNotInflateRepeatQuantity: boolean;
      rescansDoNotInflateComparablePoints: boolean;
      rescansDoNotInflatePphGrossOrQuantity: boolean;
      physicalGroupsCollapsed: DeepPhysicalGroupConsumerAudit[];
    };
  };
};
