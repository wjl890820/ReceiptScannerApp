/**
 * Experiment Snapshot Export V1 — read-only local research export.
 *
 * Answers: "What does Meruno currently know about this shopping history?"
 * Reuses production domain builders. Does not create a second truth.
 *
 * Offline. No AI/network. No DB writes. No schema changes.
 */

import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
  type AnalyticsReceiptSelection,
} from './analyticsReceiptSelection';
import { resolveEffectiveReceiptTaxProvenance } from './analysisFoundation/taxProvenance';
import { prepareAnalysisPriceInsightContext } from './analysisPricePreparedContext';
import {
  collectAnalysisTrustedPriceChangeCandidates,
  type AnalysisTrustedPriceChangeCandidate,
} from './analysisTrustedPriceChanges';
import type { ReceiptRow } from './db';
import {
  getInitializedReceiptsDatabaseOrThrow,
  listReceiptsForAnalysisWithDb,
  ReceiptsDatabaseNotInitializedError,
} from './db';
import {
  loadEngagementProductInsightContextWithDb,
} from './engagementMilestones';
import {
  assertExperimentSnapshotExperimentInput,
} from './experimentSnapshotSettings';
import { PRODUCT_IDENTITY_RESOLVER_VERSION } from './productIdentityContract';
import type { PersonalProductEndpointInventory } from './personalProductEndpointInventory';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryObservation,
  type ProductPriceHistoryPoint,
  type ProductPriceHistoryResult,
  type ProductPriceHistoryRow,
  type ProductPriceHistoryStatus,
} from './productPriceHistory';
import {
  buildRepeatIntervalStats,
  buildRepeatProductProfiles,
  type RepeatProductProfile,
} from './repeatProductProfile';

export const EXPERIMENT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const EXPERIMENT_SNAPSHOT_NAME = 'Experiment Snapshot';

/**
 * Honest receiptItems universe for V1:
 * analytics/canonical-deduped engagement product-row projection —
 * not all stored receipt_items rows.
 */
export const EXPERIMENT_SNAPSHOT_RECEIPT_ITEM_UNIVERSE =
  'analytics_engagement_rows' as const;

export type ExperimentSnapshotReceiptItemUniverse =
  typeof EXPERIMENT_SNAPSHOT_RECEIPT_ITEM_UNIVERSE;

export type ExperimentSnapshotExperimentMeta = {
  phase: number;
  completedReceiptSequence: number;
  nextReceiptSequence: number;
};

export type ExperimentSnapshotAppMeta = {
  version: string | null;
  build: string | null;
  locale: string | null;
};

export type ExperimentSnapshotTaxProvenanceProjection = {
  trust: 'trusted' | 'untrusted';
  source: string;
};

export type ExperimentSnapshotDuplicateProjection = {
  excluded: boolean;
  representativeReceiptId: string | null;
  confidence: string | null;
  memberReceiptIds: string[] | null;
};

export type ExperimentSnapshotReceipt = {
  id: string;
  createdAt: number;
  transactionAt: number | null;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  merchantType: string | null;
  total: number;
  tax: number;
  taxIsKnown: number | null;
  currency: string;
  userEdited: number;
  finalTotal: number | null;
  analyticsIncluded: boolean;
  duplicate: ExperimentSnapshotDuplicateProjection;
  taxProvenance: ExperimentSnapshotTaxProvenanceProjection;
};

export type ExperimentSnapshotReceiptItem = {
  itemId: string;
  receiptId: string;
  sourceIndex: number;
  /**
   * Engagement SQL COALESCE display projection (authoritative as display only).
   * Not raw/normalized provenance.
   */
  displayName: string | null;
  /** Only when a separate authoritative projection exists (V1: null). */
  rawName: string | null;
  /** Only when a separate authoritative projection exists (V1: null). */
  normalizedName: string | null;
  canonicalProductName: string | null;
  /** Only when a separate authoritative projection exists (V1: null). */
  brand: string | null;
  quantity: number | null;
  currency: string | null;
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  discountAllocated: number | null;
  amountProvenance: string | null;
  itemAmountEvidenceState: string | null;
  priceObservationVersion: number | null;
  skuKey: string | null;
  productFamilyKey: string | null;
  identitySource: string | null;
  identityConfidence: number | null;
  identityLevel: string | null;
  merchantProductId: string | null;
};

export type ExperimentSnapshotProductIdentity = {
  kind: string;
  identityKey: string;
  displayName: string;
  purchaseOccurrenceCount: number;
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
};

export type ExperimentSnapshotPurchaseMemoryProfile = {
  identityKind: string;
  identityKey: string;
  displayName: string;
  purchaseOccurrenceCount: number;
  datedPurchaseOccurrenceCount: number;
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
  purchaseEventDates: number[];
  intervalSampleSize: number;
  medianIntervalDays: number | null;
  previousPurchasedAt: number | null;
  totalPurchaseQuantity: number | null;
};

export type ExperimentSnapshotPriceHistoryPoint = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  occurredAt: number;
  priceValue: number;
  purchaseQuantity: number;
  currency: string;
  grossLineAmount: number;
  amountBasis: string | null;
  qualityLevel: string | null;
  skuKey: string | null;
  merchantProductId: string | null;
  identityLevel: string | null;
  identitySource: string | null;
};

export type ExperimentSnapshotPriceHistoryObservation = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  occurredAt: number;
  level2Eligible: boolean;
  level2RejectReasons: string[];
  amountBasis: string | null;
  monetaryCoherenceState: string | null;
  monetaryProvenanceSufficient: boolean;
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  purchaseQuantity: number | null;
  qualityLevel: string | null;
};

export type ExperimentSnapshotPriceHistory = {
  targetType: string;
  targetKey: string;
  status: ProductPriceHistoryStatus;
  totalOccurrenceCount: number;
  comparableOccurrenceCount: number;
  excludedOccurrenceCount: number;
  currency: string | null;
  priceKind: string | null;
  seriesKind: string | null;
  amountBasis: string | null;
  detail: 'full' | 'summary';
  points: ExperimentSnapshotPriceHistoryPoint[] | null;
  observations: ExperimentSnapshotPriceHistoryObservation[] | null;
};

export type ExperimentSnapshotPriceChangeCandidate = {
  targetType: string;
  targetKey: string;
  displayName: string;
  comparableOccurrenceCount: number;
  latestOccurredAt: number;
  currentReceiptId: string;
  previousReceiptId: string;
  currentPriceValue: number;
  previousPriceValue: number;
};

export type ExperimentSnapshotDatasetSummary = {
  storedReceiptCount: number;
  analyticsPurchaseCount: number;
  excludedDuplicateCount: number;
  receiptItemCount: number;
  /** Honest label: analytics-deduped engagement rows, not all stored receipt_items. */
  receiptItemUniverse: ExperimentSnapshotReceiptItemUniverse;
  identityCount: number;
  priceHistoryStatusCounts: Record<string, number>;
  trustedPriceChangeCandidateCount: number;
};

export type ExperimentSnapshotCurrentDomainState = {
  trustedPriceChangeCandidates: ExperimentSnapshotPriceChangeCandidate[];
};

export type ExperimentSnapshot = {
  schemaVersion: typeof EXPERIMENT_SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  app: ExperimentSnapshotAppMeta;
  identityResolverVersion: string;
  experiment: ExperimentSnapshotExperimentMeta;
  datasetSummary: ExperimentSnapshotDatasetSummary;
  receipts: ExperimentSnapshotReceipt[];
  receiptItems: ExperimentSnapshotReceiptItem[];
  productIdentities: ExperimentSnapshotProductIdentity[];
  purchaseMemory: {
    repeatProfiles: ExperimentSnapshotPurchaseMemoryProfile[];
  };
  priceHistories: ExperimentSnapshotPriceHistory[];
  currentDomainState: ExperimentSnapshotCurrentDomainState;
};

export type BuildExperimentSnapshotInput = {
  experiment: {
    phase: number;
    completedReceiptSequence: number;
  };
  storedReceipts: readonly ReceiptRow[];
  /** Analytics-deduped product insight rows (production engagement loader shape). */
  productRows: readonly ProductPriceHistoryRow[];
  personalInventory?: PersonalProductEndpointInventory | null;
  app?: Partial<ExperimentSnapshotAppMeta> | null;
  nowMs?: number;
  /**
   * Optional precomputed selection — when omitted, uses selectAnalyticsReceipts.
   * Tests may inject the same selection used to filter productRows.
   */
  selection?: AnalyticsReceiptSelection;
  /**
   * Optional price-history builder (defaults to production buildProductPriceHistory).
   * Tests may wrap to assert reuse.
   */
  buildHistory?: typeof buildProductPriceHistory;
  /**
   * Optional trusted price-change collector (defaults to production sync collect).
   */
  collectPriceChangeCandidates?: (
    input: Parameters<typeof collectAnalysisTrustedPriceChangeCandidates>[0]
  ) => AnalysisTrustedPriceChangeCandidate[];
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildExperimentSnapshotFilename(
  nowMs: number = Date.now()
): string {
  const d = new Date(nowMs);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `meruno-experiment-snapshot-${stamp}.json`;
}

/** Strict experiment metadata — next is always completed + 1. */
export function resolveExperimentSnapshotExperimentMeta(input: {
  phase: number;
  completedReceiptSequence: number;
}): ExperimentSnapshotExperimentMeta {
  return assertExperimentSnapshotExperimentInput(input);
}

function projectTaxProvenance(
  receipt: ReceiptRow
): ExperimentSnapshotTaxProvenanceProjection {
  const decision = resolveEffectiveReceiptTaxProvenance(receipt).decision;
  return {
    trust: decision.trust,
    source: decision.source,
  };
}

function projectReceipts(
  selection: AnalyticsReceiptSelection
): ExperimentSnapshotReceipt[] {
  const membership = indexHighConfidenceDuplicateGroupsByReceiptId(
    selection.highConfidenceDuplicateGroups
  );
  const excluded = selection.excludedDuplicateReceiptIds;

  return selection.storedReceipts.map((receipt) => {
    const group = membership.get(receipt.id) ?? null;
    const isExcluded = excluded.has(receipt.id);
    return {
      id: receipt.id,
      createdAt: receipt.created_at,
      transactionAt: receipt.transaction_at,
      merchantRaw: receipt.merchant_raw,
      merchantNormalized: receipt.merchant_normalized,
      merchantType:
        receipt.merchant_type == null ? null : String(receipt.merchant_type),
      total: receipt.total,
      tax: receipt.tax,
      taxIsKnown:
        receipt.tax_is_known === undefined || receipt.tax_is_known === null
          ? null
          : Number(receipt.tax_is_known),
      currency: receipt.currency,
      userEdited: receipt.user_edited ?? 0,
      finalTotal: receipt.final_total ?? null,
      analyticsIncluded: !isExcluded,
      duplicate: {
        excluded: isExcluded,
        representativeReceiptId: group?.representativeReceiptId ?? null,
        confidence: group?.confidence ?? null,
        memberReceiptIds: group ? [...group.receiptIds] : null,
      },
      taxProvenance: projectTaxProvenance(receipt),
    };
  });
}

function projectReceiptItems(
  rows: readonly ProductPriceHistoryRow[],
  identityByRowKey: ReadonlyMap<
    string,
    {
      skuKey: string | null;
      merchantProductId: string | null;
      identityLevel: string;
      identityConfidence: number | null;
      identitySource: string | null;
    }
  >
): ExperimentSnapshotReceiptItem[] {
  return rows.map((row) => {
    const key = `${row.receiptId}:${row.sourceIndex}`;
    const identity = identityByRowKey.get(key);
    const displayName = row.displayName?.trim() || null;
    const canonicalProductName =
      (row as { canonicalProductName?: string | null }).canonicalProductName ??
      null;
    return {
      itemId: row.itemId,
      receiptId: row.receiptId,
      sourceIndex: row.sourceIndex,
      displayName,
      // Engagement COALESCE displayName is not raw/normalized/brand provenance.
      rawName: null,
      normalizedName: null,
      brand: null,
      canonicalProductName:
        typeof canonicalProductName === 'string' && canonicalProductName.trim()
          ? canonicalProductName.trim()
          : null,
      quantity: row.purchaseQuantity,
      currency: row.currency,
      grossLineAmount: row.grossLineAmount ?? null,
      effectiveLineAmount: row.effectiveLineAmount ?? null,
      discountAllocated: row.discountAllocated ?? null,
      amountProvenance:
        row.amountProvenance == null ? null : String(row.amountProvenance),
      itemAmountEvidenceState:
        row.itemAmountEvidenceState == null
          ? null
          : String(row.itemAmountEvidenceState),
      priceObservationVersion: row.priceObservationVersion ?? null,
      skuKey: row.skuKey?.trim() || identity?.skuKey || null,
      productFamilyKey: row.productFamilyKey,
      identitySource:
        identity?.identitySource ??
        (row.identitySource == null ? null : String(row.identitySource)),
      identityConfidence:
        identity?.identityConfidence ?? row.identityConfidence ?? null,
      identityLevel: identity?.identityLevel ?? null,
      merchantProductId: identity?.merchantProductId ?? null,
    };
  });
}

function projectRepeatProfile(
  profile: RepeatProductProfile
): ExperimentSnapshotPurchaseMemoryProfile {
  const intervals = buildRepeatIntervalStats(profile);
  return {
    identityKind: profile.identityKind,
    identityKey: profile.identityKey,
    displayName: profile.displayName,
    purchaseOccurrenceCount: profile.purchaseOccurrenceCount,
    datedPurchaseOccurrenceCount: profile.datedPurchaseOccurrenceCount,
    firstPurchasedAt: profile.firstPurchasedAt,
    lastPurchasedAt: profile.lastPurchasedAt,
    purchaseEventDates: [...profile.purchaseEventDates],
    intervalSampleSize: intervals.intervalSampleSize,
    medianIntervalDays: intervals.medianIntervalDays,
    previousPurchasedAt: intervals.previousPurchasedAt,
    totalPurchaseQuantity:
      profile.totalPurchaseQuantity === undefined
        ? null
        : profile.totalPurchaseQuantity,
  };
}

/**
 * Identity summary for every merchant_product / sku bucket (incl. occurrence=1).
 * Repeat profiles remain the occurrence>=2 replenishment SSOT under purchaseMemory.
 */
function projectProductIdentitiesFromPrepared(
  prepared: ReturnType<typeof prepareAnalysisPriceInsightContext>,
  repeatProfiles: readonly ExperimentSnapshotPurchaseMemoryProfile[]
): ExperimentSnapshotProductIdentity[] {
  const byKey = new Map<string, ExperimentSnapshotProductIdentity>();

  for (const [mpId, rows] of prepared.merchantProductBuckets) {
    const receiptIds = new Set(rows.map((row) => row.receiptId));
    const dated = rows
      .map((row) => row.occurredAt)
      .filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts) && ts > 0)
      .sort((a, b) => a - b);
    const displayName =
      rows
        .map((row) => row.displayName?.trim())
        .find((name): name is string => !!name) || mpId;
    byKey.set(`merchant_product:${mpId}`, {
      kind: 'merchant_product',
      identityKey: mpId,
      displayName,
      purchaseOccurrenceCount: receiptIds.size,
      firstPurchasedAt: dated[0] ?? null,
      lastPurchasedAt: dated.length > 0 ? dated[dated.length - 1]! : null,
    });
  }

  for (const [skuKey, rows] of prepared.skuBuckets) {
    const receiptIds = new Set(rows.map((row) => row.receiptId));
    const dated = rows
      .map((row) => row.occurredAt)
      .filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts) && ts > 0)
      .sort((a, b) => a - b);
    const displayName =
      rows
        .map((row) => row.displayName?.trim())
        .find((name): name is string => !!name) || skuKey;
    byKey.set(`sku:${skuKey}`, {
      kind: 'sku',
      identityKey: skuKey,
      displayName,
      purchaseOccurrenceCount: receiptIds.size,
      firstPurchasedAt: dated[0] ?? null,
      lastPurchasedAt: dated.length > 0 ? dated[dated.length - 1]! : null,
    });
  }

  // Prefer Repeat SSOT counts/dates when available (same key).
  for (const profile of repeatProfiles) {
    const key = `${profile.identityKind}:${profile.identityKey}`;
    byKey.set(key, {
      kind: profile.identityKind,
      identityKey: profile.identityKey,
      displayName: profile.displayName,
      purchaseOccurrenceCount: profile.purchaseOccurrenceCount,
      firstPurchasedAt: profile.firstPurchasedAt,
      lastPurchasedAt: profile.lastPurchasedAt,
    });
  }

  return [...byKey.values()].sort(
    (left, right) =>
      right.purchaseOccurrenceCount - left.purchaseOccurrenceCount ||
      left.kind.localeCompare(right.kind) ||
      left.identityKey.localeCompare(right.identityKey)
  );
}

function projectPricePoint(
  point: ProductPriceHistoryPoint
): ExperimentSnapshotPriceHistoryPoint {
  return {
    receiptId: point.receiptId,
    itemId: point.itemId,
    sourceIndex: point.sourceIndex,
    occurredAt: point.occurredAt,
    priceValue: point.priceValue,
    purchaseQuantity: point.purchaseQuantity,
    currency: point.currency,
    grossLineAmount: point.grossLineAmount,
    amountBasis: point.amountBasis == null ? null : String(point.amountBasis),
    qualityLevel:
      point.qualityLevel == null ? null : String(point.qualityLevel),
    skuKey: point.skuKey ?? null,
    merchantProductId: point.merchantProductId ?? null,
    identityLevel:
      point.identityLevel == null ? null : String(point.identityLevel),
    identitySource: point.identitySource ?? null,
  };
}

function projectPriceObservation(
  observation: ProductPriceHistoryObservation
): ExperimentSnapshotPriceHistoryObservation {
  return {
    receiptId: observation.receiptId,
    itemId: observation.itemId,
    sourceIndex: observation.sourceIndex,
    occurredAt: observation.occurredAt,
    level2Eligible: observation.level2Eligible,
    level2RejectReasons: [...observation.level2RejectReasons],
    amountBasis:
      observation.amountBasis == null ? null : String(observation.amountBasis),
    monetaryCoherenceState:
      observation.monetaryCoherenceState == null
        ? null
        : String(observation.monetaryCoherenceState),
    monetaryProvenanceSufficient: observation.monetaryProvenanceSufficient,
    grossLineAmount: observation.grossLineAmount,
    effectiveLineAmount: observation.effectiveLineAmount,
    purchaseQuantity: observation.purchaseQuantity,
    qualityLevel:
      observation.qualityLevel == null
        ? null
        : String(observation.qualityLevel),
  };
}

/**
 * Scope rule (V1):
 * - Every prepared sku / merchant_product bucket gets a history entry (incl. not_enough_points).
 * - Full points+observations when occurrence>=2 OR status==='ready' OR any reject reasons.
 * - Otherwise summary-only (status + counts; observations/points null) for trivial single hits.
 */
export function shouldExportFullPriceHistoryDetail(
  result: ProductPriceHistoryResult
): boolean {
  if (result.status === 'ready') return true;
  if (result.totalOccurrenceCount >= 2) return true;
  if (result.comparableOccurrenceCount >= 1) return true;
  if (
    result.observations.some((observation) => observation.level2RejectReasons.length > 0)
  ) {
    return true;
  }
  return false;
}

function projectPriceHistory(
  result: ProductPriceHistoryResult
): ExperimentSnapshotPriceHistory {
  const full = shouldExportFullPriceHistoryDetail(result);
  const targetKey =
    result.target.type === 'occurrence'
      ? `${result.target.receiptId}:${result.target.itemId}`
      : result.target.key;
  return {
    targetType: result.target.type,
    targetKey,
    status: result.status,
    totalOccurrenceCount: result.totalOccurrenceCount,
    comparableOccurrenceCount: result.comparableOccurrenceCount,
    excludedOccurrenceCount: result.excludedOccurrenceCount,
    currency: result.currency,
    priceKind: result.priceKind,
    seriesKind: result.seriesKind,
    amountBasis: result.amountBasis,
    detail: full ? 'full' : 'summary',
    points: full ? result.points.map(projectPricePoint) : null,
    observations: full
      ? result.observations.map(projectPriceObservation)
      : null,
  };
}

function projectPriceChangeCandidate(
  candidate: AnalysisTrustedPriceChangeCandidate
): ExperimentSnapshotPriceChangeCandidate {
  return {
    targetType: candidate.target.type,
    targetKey: candidate.target.key,
    displayName: candidate.displayName,
    comparableOccurrenceCount: candidate.comparableOccurrenceCount,
    latestOccurredAt: candidate.latestOccurredAt,
    currentReceiptId: candidate.interpretation.current.receiptId,
    previousReceiptId: candidate.interpretation.previous.receiptId,
    currentPriceValue: candidate.interpretation.current.priceValue,
    previousPriceValue: candidate.interpretation.previous.priceValue,
  };
}

function buildPriceHistoriesFromPrepared(
  prepared: ReturnType<typeof prepareAnalysisPriceInsightContext>,
  buildHistory: typeof buildProductPriceHistory
): ExperimentSnapshotPriceHistory[] {
  const out: ExperimentSnapshotPriceHistory[] = [];
  const rowIdentityMetadata = new Map(prepared.rowIdentityMetadata);

  const skuKeys = [...prepared.skuBuckets.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  for (const skuKey of skuKeys) {
    const rows = prepared.skuBuckets.get(skuKey) ?? [];
    const result = buildHistory({ type: 'sku', key: skuKey }, [...rows], {
      receiptEvidenceCache: prepared.receiptEvidenceCache,
      preparedRowIdentityMetadata: rowIdentityMetadata,
      canonicalDuplicateSelectionApplied: true,
    });
    out.push(projectPriceHistory(result));
  }

  const mpIds = [...prepared.merchantProductBuckets.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  for (const mpId of mpIds) {
    const rows = prepared.merchantProductBuckets.get(mpId) ?? [];
    const result = buildHistory(
      { type: 'merchant_product', key: mpId },
      [...rows],
      {
        receiptEvidenceCache: prepared.receiptEvidenceCache,
        preparedRowIdentityMetadata: rowIdentityMetadata,
        preparedMerchantProductIdentityView:
          prepared.merchantProductIdentityViews.get(mpId) ?? null,
        canonicalDuplicateSelectionApplied: true,
      }
    );
    out.push(projectPriceHistory(result));
  }

  return out;
}

function countPriceHistoryStatuses(
  histories: readonly ExperimentSnapshotPriceHistory[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const history of histories) {
    counts[history.status] = (counts[history.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Pure assembler: builds Experiment Snapshot from already-loaded local truth.
 * Does not touch SQLite / network / AI.
 */
export function buildExperimentSnapshot(
  input: BuildExperimentSnapshotInput
): ExperimentSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const experiment = resolveExperimentSnapshotExperimentMeta(input.experiment);
  const selection =
    input.selection ?? selectAnalyticsReceipts([...input.storedReceipts]);
  const seedReceiptIds = new Set(
    selection.analyticsReceipts.map((receipt) => receipt.id)
  );
  const productRows = [...input.productRows];
  const prepared = prepareAnalysisPriceInsightContext(
    productRows,
    seedReceiptIds
  );
  const buildHistory = input.buildHistory ?? buildProductPriceHistory;
  const collectCandidates =
    input.collectPriceChangeCandidates ??
    collectAnalysisTrustedPriceChangeCandidates;

  const receipts = projectReceipts(selection);
  const receiptItems = projectReceiptItems(
    productRows,
    prepared.rowIdentityMetadata
  );

  const repeatProfiles = buildRepeatProductProfiles(
    selection.analyticsReceipts,
    productRows,
    { personalInventory: input.personalInventory ?? null }
  );
  const purchaseMemoryProfiles = repeatProfiles.map(projectRepeatProfile);

  const productIdentities = projectProductIdentitiesFromPrepared(
    prepared,
    purchaseMemoryProfiles
  );

  const priceHistories = buildPriceHistoriesFromPrepared(prepared, buildHistory);

  const priceChangeCandidates = collectCandidates({
    rows: productRows,
    seedReceiptIds,
    prepared,
    canonicalDuplicateSelectionApplied: true,
    buildHistory,
  }).map(projectPriceChangeCandidate);

  const datasetSummary: ExperimentSnapshotDatasetSummary = {
    storedReceiptCount: receipts.length,
    analyticsPurchaseCount: receipts.filter((r) => r.analyticsIncluded).length,
    excludedDuplicateCount: receipts.filter((r) => !r.analyticsIncluded).length,
    receiptItemCount: receiptItems.length,
    receiptItemUniverse: EXPERIMENT_SNAPSHOT_RECEIPT_ITEM_UNIVERSE,
    identityCount: productIdentities.length,
    priceHistoryStatusCounts: countPriceHistoryStatuses(priceHistories),
    trustedPriceChangeCandidateCount: priceChangeCandidates.length,
  };

  const snapshot: ExperimentSnapshot = {
    schemaVersion: EXPERIMENT_SNAPSHOT_SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    app: {
      version: input.app?.version ?? null,
      build: input.app?.build ?? null,
      locale: input.app?.locale ?? null,
    },
    identityResolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    experiment,
    datasetSummary,
    receipts,
    receiptItems,
    productIdentities,
    purchaseMemory: {
      repeatProfiles: purchaseMemoryProfiles,
    },
    priceHistories,
    currentDomainState: {
      trustedPriceChangeCandidates: priceChangeCandidates,
    },
  };
  assertExperimentSnapshotFiniteNumbers(snapshot);
  return snapshot;
}

export function formatExperimentSnapshotExportSummary(
  snapshot: ExperimentSnapshot
): string {
  const summary = snapshot.datasetSummary;
  return `stored=${summary.storedReceiptCount}\ncanonical=${summary.analyticsPurchaseCount}`;
}

/**
 * Fail-closed: JSON number fields must be finite.
 * Does not rewrite production values — rejects export instead of NaN→null.
 */
export function assertExperimentSnapshotFiniteNumbers(
  value: unknown,
  path: string = '$'
): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`experiment_snapshot_non_finite_number:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertExperimentSnapshotFiniteNumbers(entry, `${path}[${index}]`)
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>
    )) {
      assertExperimentSnapshotFiniteNumbers(child, `${path}.${key}`);
    }
  }
}

/** JSON-safe plain object → pretty string. */
export function serializeExperimentSnapshot(
  snapshot: ExperimentSnapshot
): string {
  assertExperimentSnapshotFiniteNumbers(snapshot);
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Assert snapshot is JSON-round-trippable plain data (no capability tokens).
 */
export function assertExperimentSnapshotJsonSafe(
  snapshot: ExperimentSnapshot
): ExperimentSnapshot {
  assertExperimentSnapshotFiniteNumbers(snapshot);
  const json = serializeExperimentSnapshot(snapshot);
  const parsed = JSON.parse(json) as ExperimentSnapshot;
  if (parsed.schemaVersion !== EXPERIMENT_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('experiment_snapshot_schema_mismatch');
  }
  assertExperimentSnapshotFiniteNumbers(parsed);
  return parsed;
}

export type WriteExperimentSnapshotFileDeps = {
  snapshot: ExperimentSnapshot;
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  nowMs?: number;
};

export async function writeExperimentSnapshotFile(
  deps: WriteExperimentSnapshotFileDeps
): Promise<{ fileUri: string; filename: string; json: string }> {
  if (!deps.cacheDirectory) {
    throw new Error(
      'Cache directory unavailable; cannot export Experiment Snapshot.'
    );
  }
  const filename = buildExperimentSnapshotFilename(deps.nowMs ?? Date.now());
  const json = serializeExperimentSnapshot(deps.snapshot);
  const fileUri = `${deps.cacheDirectory}${filename}`;
  await deps.writeAsStringAsync(fileUri, json);
  return { fileUri, filename, json };
}

export type ShareExperimentSnapshotFileDeps = {
  fileUri: string;
  filename: string;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (
    url: string,
    options?: {
      mimeType?: string;
      UTI?: string;
      dialogTitle?: string;
    }
  ) => Promise<void>;
};

export async function shareExperimentSnapshotFile(
  deps: ShareExperimentSnapshotFileDeps
): Promise<void> {
  const available = await deps.isAvailableAsync();
  if (!available) {
    throw new Error(
      'Native file sharing is unavailable on this device. Cannot export Experiment Snapshot as a file.'
    );
  }
  await deps.shareAsync(deps.fileUri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: deps.filename,
  });
}

export type BuildExperimentSnapshotFromLocalDbDeps = {
  experiment: {
    phase: number;
    completedReceiptSequence: number;
  };
  app?: Partial<ExperimentSnapshotAppMeta> | null;
  nowMs?: number;
  /**
   * Observational DB gate — must never call initIfNeeded.
   * Default: getInitializedReceiptsDatabaseOrThrow.
   */
  requireInitializedDb?: () => import('expo-sqlite').SQLiteDatabase;
  listReceiptsWithDb?: (
    db: import('expo-sqlite').SQLiteDatabase
  ) => Promise<ReceiptRow[]>;
  loadProductRowsWithDb?: (
    db: import('expo-sqlite').SQLiteDatabase
  ) => Promise<ProductPriceHistoryRow[]>;
  loadPersonalInventoryWithDb?: (
    db: import('expo-sqlite').SQLiteDatabase
  ) => Promise<PersonalProductEndpointInventory | null>;
  buildHistory?: typeof buildProductPriceHistory;
  collectPriceChangeCandidates?: BuildExperimentSnapshotInput['collectPriceChangeCandidates'];
};

/**
 * Production observational load path.
 * Requires an already-initialized local DB — never calls initIfNeeded.
 * Bulk receipts + bulk engagement product rows → assemble.
 * Offline. No N+1 per-identity DB queries.
 */
export async function buildExperimentSnapshotFromLocalDb(
  deps: BuildExperimentSnapshotFromLocalDbDeps
): Promise<ExperimentSnapshot> {
  const requireInitializedDb =
    deps.requireInitializedDb ?? getInitializedReceiptsDatabaseOrThrow;
  const db = requireInitializedDb();

  const listReceipts =
    deps.listReceiptsWithDb ?? listReceiptsForAnalysisWithDb;
  const loadProductRows =
    deps.loadProductRowsWithDb ??
    (async (database) => {
      const context = await loadEngagementProductInsightContextWithDb(
        database,
        { includeRecognitionSnapshot: false }
      );
      if (context.queryFailed) {
        throw new Error('experiment_snapshot_product_rows_unavailable');
      }
      return context.rows;
    });
  const loadPersonalInventory =
    deps.loadPersonalInventoryWithDb ??
    (async (database) => {
      try {
        const {
          loadPersonalProductEndpointInventoryWithDb,
        } = await import('./personalProductEndpointInventory');
        const result = await loadPersonalProductEndpointInventoryWithDb(
          database
        );
        return result.status === 'ready' ? result.inventory : null;
      } catch {
        return null;
      }
    });

  const storedReceipts = await listReceipts(db);
  const selection = selectAnalyticsReceipts(storedReceipts);
  const productRows = await loadProductRows(db);
  const personalInventory = await loadPersonalInventory(db);

  return buildExperimentSnapshot({
    experiment: deps.experiment,
    storedReceipts,
    selection,
    productRows,
    personalInventory,
    app: deps.app,
    nowMs: deps.nowMs,
    buildHistory: deps.buildHistory,
    collectPriceChangeCandidates: deps.collectPriceChangeCandidates,
  });
}

export { ReceiptsDatabaseNotInitializedError };

export type ExportAndShareExperimentSnapshotDeps = {
  experiment: {
    phase: number;
    completedReceiptSequence: number;
  };
  app?: Partial<ExperimentSnapshotAppMeta> | null;
  nowMs?: number;
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: ShareExperimentSnapshotFileDeps['shareAsync'];
  buildSnapshot?: (
    deps: BuildExperimentSnapshotFromLocalDbDeps
  ) => Promise<ExperimentSnapshot>;
};

/**
 * End-to-end: assemble → write cache → Share Sheet.
 * Does not auto-increment experiment sequence.
 */
export async function exportAndShareExperimentSnapshot(
  deps: ExportAndShareExperimentSnapshotDeps
): Promise<{
  fileUri: string;
  filename: string;
  snapshot: ExperimentSnapshot;
}> {
  const build =
    deps.buildSnapshot ?? buildExperimentSnapshotFromLocalDb;
  const snapshot = await build({
    experiment: deps.experiment,
    app: deps.app,
    nowMs: deps.nowMs,
  });
  assertExperimentSnapshotJsonSafe(snapshot);
  const written = await writeExperimentSnapshotFile({
    snapshot,
    cacheDirectory: deps.cacheDirectory,
    writeAsStringAsync: deps.writeAsStringAsync,
    nowMs: deps.nowMs,
  });
  await shareExperimentSnapshotFile({
    fileUri: written.fileUri,
    filename: written.filename,
    isAvailableAsync: deps.isAvailableAsync,
    shareAsync: deps.shareAsync,
  });
  return {
    fileUri: written.fileUri,
    filename: written.filename,
    snapshot,
  };
}

/** Forbidden keys that must never appear in serialized Experiment Snapshot JSON. */
export const EXPERIMENT_SNAPSHOT_FORBIDDEN_JSON_SUBSTRINGS = [
  'analysis_json',
  'recognition_snapshot_json',
  'image_uri',
  'receiptAnalysisJson',
  'receiptRecognitionSnapshotJson',
  'receiptUserItemsJson',
  'access_token',
  'refresh_token',
  'supabase',
  'Authorization',
] as const;
