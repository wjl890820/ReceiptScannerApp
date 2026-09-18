/**
 * Meruno Receipt Regression Harness — Phase 1 types.
 * Offline snapshot mode only. No OCR / network / DB mutation.
 */

export const REGRESSION_HARNESS_VERSION = '1.0.3-phase1';

export type BaselineStage =
  | 'recognition_snapshot'
  | 'analysis_current'
  | 'unavailable';

export type CanonicalItemProjection = {
  sourceIndex: number;
  name: string | null;
  normalizedName: string | null;
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  effectiveLineTotal: number | null;
  discountAllocated: number | null;
  category: string | null;
  categoryMain: string | null;
  categorySub: string | null;
  productFamilyKey: string | null;
};

export type CanonicalReconciliation = {
  ok: boolean;
  diff: number;
  itemsPositiveSum: number;
  discountsSum: number;
};

export type CanonicalReceiptProjection = {
  merchantRaw: string | null;
  merchantNormalized: string | null;
  transactionAt: string | null;
  total: number | null;
  tax: number | null;
  currency: string | null;
  itemRowCount: number;
  quantityTotal: number;
  items: CanonicalItemProjection[];
  discountsTotal: number;
  reconciliation: CanonicalReconciliation;
  amountMismatch: boolean | null;
};

export type TruthItemConstraint = {
  name?: string;
  quantity?: number;
  unitPrice?: number;
  lineTotal?: number;
};

export type TruthFields = {
  merchant?: string;
  transactionAt?: string;
  total?: number;
  tax?: number;
  currency?: string;
  itemRowCount?: number;
  quantityTotal?: number;
  items?: TruthItemConstraint[];
  /** When true, itemRowCount/quantityTotal and listed items form a complete basket. */
  completeBasket?: boolean;
  /** Receipt074: coupon ownership unresolved — do not grade egg effective 598. */
  couponOwnershipUnresolved?: boolean;
  /** Confirmed ordered line amounts only (e.g. Receipt080). */
  orderedLineAmounts?: number[];
  /** Confirmed named merchandise rows without requiring full basket. */
  confirmedMerchandise?: Array<{
    nameContains?: string;
    name?: string;
    quantity?: number;
    unitPrice?: number;
    lineTotal?: number;
  }>;
  /** Confirmed coupon line (label + amount). */
  confirmedCoupon?: { labelContains?: string; amount: number };
  notes?: string[];
};

export type RegressionManifest = {
  schemaVersion: 1;
  receiptNo: number;
  selectors?: {
    merchant?: string;
    transactionAt?: string;
    total?: number;
    /**
     * exact (default): ±2 min; NEVER ignores year.
     * local_clock_ignore_year: explicit OCR year-drift opt-in; requires merchant+total.
     */
    transactionAtMatch?: 'exact' | 'local_clock_ignore_year';
    /**
     * Diagnostic reference amounts only — NOT a membership hard filter.
     * Reported per member as lineAmountsFingerprint status.
     */
    orderedLineAmountsFingerprint?: number[];
  };
  /**
   * Observational IDs from a prior export. NOT used for matching
   * (future exports may differ).
   */
  sourceReceiptIds?: string[];
  truth: TruthFields;
  image?: { available?: boolean; path?: string | null; sha256?: string | null };
  notes?: string[];
};

export type FieldVerdict =
  | 'CORRECT_STABLE'
  | 'IMPROVEMENT'
  | 'REGRESSION'
  | 'CHANGED_STILL_INCORRECT'
  | 'STABLE_INCORRECT'
  | 'UNKNOWN'
  | 'UNCHANGED'
  | 'CHANGED_UNKNOWN';

export type FieldComparison = {
  field: string;
  verdict: FieldVerdict;
  truth?: unknown;
  baseline?: unknown;
  current?: unknown;
  detail?: string;
};

export type MerchantCompareResult = {
  merchantExact: boolean;
  merchantRetailerCompatible: boolean;
  truthRetailerKey: string | null;
  currentRetailerKey: string | null;
  verdict: FieldVerdict;
};

export type ParsedNestedJson =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export type LoadedHistoricalRow = {
  receiptId: string;
  createdAt: number | null;
  transactionAt: number | null;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  total: number | null;
  tax: number | null;
  currency: string | null;
  baselineStage: BaselineStage;
  fallbackReason: string | null;
  parseError: string | null;
  /** Redacted image presence only. */
  imageUriPresent: boolean;
  analysisObject: Record<string, unknown> | null;
  snapshotObject: Record<string, unknown> | null;
  /** Preferred payload for projection (snapshot or analysis). */
  baselinePayload: Record<string, unknown> | null;
  rawRowKeys: string[];
};

export type DeterministicChecksResult = {
  projection: CanonicalReceiptProjection;
  retailerKey: string | null;
  retailerDisplayName: string | null;
  indexRowCount: number;
  identityProjected: boolean;
  quantityPriceIssues: string[];
  specParsedCount: number;
  normalizeReplayExperimental: null;
};

export type MatchedMemberObservation = {
  receiptId: string;
  date: string | null;
  tax: number | null;
  itemRowCount: number;
  connectionPhantom: boolean;
  baselineStage: string;
  createdAt: number | null;
  /** Diagnostic fingerprint vs selector/truth reference amounts. */
  lineAmountsFingerprint: import('./matchManifest').LineAmountsFingerprintStatus;
  /** Per-member truth field grades (subset). */
  fieldComparisons: FieldComparison[];
};

export type MatchedManifestResult = {
  receiptNo: number;
  matchedHistoricalRows: string[];
  duplicateHistoricalRows: boolean;
  representativeReceiptId: string | null;
  representativeRule: string | null;
  unmatched: boolean;
  /** Present when unmatched. */
  unmatchedReason?: 'source_missing' | 'selector_failed' | null;
  fieldComparisons: FieldComparison[];
  merchantCompare: MerchantCompareResult | null;
  completeBasket: boolean;
  /** All matched historical members (truth-independent listing + per-member grades). */
  matchedMembers?: MatchedMemberObservation[];
  /** Observational IDs from manifest (not used for matching). */
  observationalSourceReceiptIds?: string[];
};

export type RegressionReport = {
  metadata: {
    generatedAt: string;
    exportPathBasename: string;
    exportReceiptRowCount: number;
    harnessVersion: string;
    gitHead: string | null;
    failOnRegression: boolean;
  };
  summary: {
    rowsLoaded: number;
    snapshotUsable: number;
    analysisFallback: number;
    unavailable: number;
    malformedRows: number;
    physicalManifests: number;
    matchedManifests: number;
    unmatchedManifests: number;
    correctStable: number;
    improvements: number;
    regressions: number;
    changedStillIncorrect: number;
    stableIncorrect: number;
    unknown: number;
    unchangedNoTruth: number;
    changedUnknown: number;
    /** Truth-backed field counters (manifest comparisons only). */
    truthCorrectStable: number;
    truthImprovements: number;
    truthRegressions: number;
    truthStableIncorrect: number;
    truthChangedStillIncorrect: number;
    truthUnknown: number;
  };
  deepConsumers: {
    repeat: 'not_run_phase1';
    pph: 'not_run_phase1';
  };
  rows: Array<{
    receiptId: string;
    baselineStage: BaselineStage;
    fallbackReason: string | null;
    parseError: string | null;
    observed: CanonicalReceiptProjection | null;
    current: DeterministicChecksResult | null;
    noTruthFieldComparisons: FieldComparison[];
  }>;
  manifests: MatchedManifestResult[];
};
