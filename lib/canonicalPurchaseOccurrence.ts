/**
 * Canonical purchase-occurrence identity for Repeat, PPH, and visit/spend.
 *
 * Analytics HC selection may retain multiple stored rescans of one physical
 * purchase. Proven siblings must contribute ONE occurrence / ONE representative
 * receipt observation downstream.
 *
 * Conservatism (false split ≫ false merge):
 * - Merge only on durable HC relations (CONTENT_EXACT / STRUCTURAL_EXACT /
 *   RECONCILED) or exact same transaction_at + strong name-compatible basket.
 * - Basket similarity may corroborate; it must NEVER create identity when
 *   timestamps are missing or disagree (null-tx / cross-year).
 * - No durable scan-lineage / duplicate_of field exists on ReceiptRow today —
 *   relaxed timestamp recovery therefore FAIL CLOSED (do not invent provenance).
 * - Grouping is complete-link so a generic merchant cannot bridge conflicting
 *   specific branches.
 *
 * Representation is separate from grouping: aggregate lines within one receipt,
 * then pick ONE representative across rescan ids — never sum money or quantity
 * across rescan receipt ids.
 */

import type { AnalysisDDuplicateReceiptSummary } from './analysisDDuplicateAudit';
import type { ReceiptRow } from './db';
import {
  pickBestRepresentativeReceiptId,
  type RepresentativeQualitySummary,
} from './receiptRepresentativeQuality';
import { tokyoClockParts } from './tokyoClock';

export type CanonicalPurchaseOccurrenceGroup = {
  occurrenceId: string;
  receiptIds: readonly string[];
  representativeReceiptId: string;
};

export type CanonicalPurchaseOccurrenceIndex = {
  /** receiptId → stable occurrence id (lexicographically smallest member). */
  occurrenceIdByReceiptId: ReadonlyMap<string, string>;
  /** occurrenceId → deterministic representative receipt id. */
  representativeReceiptIdByOccurrenceId: ReadonlyMap<string, string>;
  /** receiptId → representative of its occurrence (identity for reps). */
  representativeReceiptIdByReceiptId: ReadonlyMap<string, string>;
  groups: readonly CanonicalPurchaseOccurrenceGroup[];
};

/**
 * Immutable pair + summary evidence for one prepared receipt universe.
 *
 * Contains NO cluster / representative / occurrence materialization.
 * Reusable for any subset X of the prepared universe via
 * {@link buildCanonicalPurchaseOccurrenceIndexFromPrepared}.
 *
 * Subset contract (Slice H2.1): each receipt passed to buildFromPrepared must
 * be the same object reference used during prepare (receiptById.get(id) === r).
 * Incompatible snapshots fall back to a fresh prepare+build for that universe.
 */
export type CanonicalPurchaseOccurrencePreparedEvidence = {
  /** Object-identity snapshots from prepare — subset safety contract. */
  receiptById: ReadonlyMap<string, ReceiptRow>;
  summariesByReceiptId: ReadonlyMap<
    string,
    AnalysisDDuplicateReceiptSummary
  >;
  /**
   * True unordered pairs only: outer key = lexicographically smaller receiptId,
   * inner set = larger receiptIds. Collision-safe (no delimiter join).
   */
  qualifiedPairs: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Test-only counters — not part of production correctness. */
export type CanonicalPurchaseOccurrencePrepareStats = {
  summarizeCount: number;
  /** n*(n-1)/2 for the normalized universe. */
  theoreticalPairCount: number;
  /** Unique unordered pairs admitted by exact candidate families. */
  candidatePairCount: number;
  /** Evaluator invocations (must equal candidatePairCount). */
  pairEvaluationCount: number;
  /** Pairs for which the evaluator returned true. */
  qualifiedPairCount: number;
};

let lastPrepareStats: CanonicalPurchaseOccurrencePrepareStats | null = null;

export function __getLastCanonicalPurchaseOccurrencePrepareStatsForTests(): CanonicalPurchaseOccurrencePrepareStats | null {
  return lastPrepareStats;
}

export function __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests(): void {
  lastPrepareStats = null;
}

/**
 * Canonical orientation for one unordered pair of opaque receipt IDs.
 *
 * Pair identity is exact and locale-independent. Complete-link edge processing
 * deliberately keeps its existing localeCompare ordering; this helper is only
 * the storage/lookup authority for qualifiedPairs.
 */
function canonicalizeOccurrencePairIds(
  receiptIdA: string,
  receiptIdB: string
): readonly [string, string] | null {
  if (receiptIdA === receiptIdB) return null;
  return receiptIdA < receiptIdB
    ? [receiptIdA, receiptIdB]
    : [receiptIdB, receiptIdA];
}

/**
 * Order-independent pair lookup against prepared Boolean evidence.
 * Nested Map+Set — never concatenates receipt IDs.
 */
export function isPreparedOccurrencePairQualified(
  prepared: CanonicalPurchaseOccurrencePreparedEvidence,
  receiptIdA: string,
  receiptIdB: string
): boolean {
  const pair = canonicalizeOccurrencePairIds(receiptIdA, receiptIdB);
  if (!pair) return false;
  const [lo, hi] = pair;
  return prepared.qualifiedPairs.get(lo)?.has(hi) === true;
}

function auditModule(): typeof import('./analysisDDuplicateAudit') {
  // Lazy require avoids pulling productPriceHistory/expo-sqlite into light
  // Repeat unit tests that only need occurrence remapping at call time.
  return require('./analysisDDuplicateAudit') as typeof import('./analysisDDuplicateAudit');
}

function moneyEquals(a: number, b: number): boolean {
  return Math.round(a) === Math.round(b);
}

function qtyAmountVectorEquals(
  left: ReadonlyArray<{ quantity: number; lineAmount: number }>,
  right: ReadonlyArray<{ quantity: number; lineAmount: number }>
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]!.quantity !== right[i]!.quantity) return false;
    if (!moneyEquals(left[i]!.lineAmount, right[i]!.lineAmount)) return false;
  }
  return true;
}

/**
 * Strong basket corroboration: ordered item names (semantic-compatible) +
 * qty/amount. Used only when exact transaction timestamps already agree.
 * Amount vector alone is never sufficient.
 */
export function strongNameCompatibleBasketEvidence(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): boolean {
  const { areSemanticRescanItemNamesCompatible } = auditModule();
  if (
    left.orderedNameCanonicals.length === 0 ||
    right.orderedNameCanonicals.length === 0
  ) {
    return false;
  }
  if (left.orderedNameCanonicals.length !== right.orderedNameCanonicals.length) {
    return false;
  }
  for (let i = 0; i < left.orderedNameCanonicals.length; i += 1) {
    const check = areSemanticRescanItemNamesCompatible(
      left.orderedNameCanonicals[i]!,
      right.orderedNameCanonicals[i]!
    );
    if (!check.compatible) return false;
  }
  if (
    left.orderedQtyAmountVector.length === 0 ||
    right.orderedQtyAmountVector.length === 0
  ) {
    return false;
  }
  if (
    !qtyAmountVectorEquals(
      left.orderedQtyAmountVector,
      right.orderedQtyAmountVector
    )
  ) {
    return false;
  }
  if (
    left.canonicalStructuralBasket.length > 0 &&
    right.canonicalStructuralBasket.length > 0 &&
    !qtyAmountVectorEquals(
      left.canonicalStructuralBasket,
      right.canonicalStructuralBasket
    )
  ) {
    return false;
  }
  return true;
}

/** Tokyo wall-clock M/D H:M:S equal ignoring year (seconds required). */
export function exactTimestampsShareTokyoClockIgnoringYear(
  leftMs: number,
  rightMs: number
): boolean {
  const a = tokyoClockParts(leftMs);
  const b = tokyoClockParts(rightMs);
  if (!a || !b) return false;
  if (a.month !== b.month || a.day !== b.day) return false;
  if (a.hour !== b.hour || a.minute !== b.minute) return false;
  if (a.second == null || b.second == null) return false;
  return a.second === b.second;
}

function taxSlotsCompatible(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): boolean {
  const leftKnownValid =
    left.taxKnown && left.tax != null && Number.isFinite(left.tax);
  const rightKnownValid =
    right.taxKnown && right.tax != null && Number.isFinite(right.tax);

  if (left.taxKnown && !leftKnownValid) return false;
  if (right.taxKnown && !rightKnownValid) return false;

  if (leftKnownValid && rightKnownValid) {
    return moneyEquals(left.tax!, right.tax!);
  }
  if (leftKnownValid && !right.taxKnown) return true;
  if (!left.taxKnown && rightKnownValid) return true;
  if (!left.taxKnown && !right.taxKnown) return true;
  return false;
}

function baseMonetaryCompatible(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): boolean {
  const { areStructuralExactMerchantKeysCompatible } = auditModule();
  if (!left.currency || left.currency !== right.currency) return false;
  if (!areStructuralExactMerchantKeysCompatible(left, right)) return false;
  if (!moneyEquals(left.total, right.total)) return false;
  if (
    !(Number.isFinite(left.total) && left.total > 0) ||
    !(Number.isFinite(right.total) && right.total > 0)
  ) {
    return false;
  }
  if (!taxSlotsCompatible(left, right)) return false;
  return true;
}

/**
 * Durable HC pair relation — independent of basket-similarity heuristics.
 * CONTENT_EXACT / STRUCTURAL_EXACT / RECONCILED (all require agreeing exact
 * clocks where applicable). No ReceiptRow duplicate_of / scan-lineage field
 * exists today for relaxed-timestamp recovery.
 */
function existingHcPair(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): boolean {
  const {
    areStructuralExactDuplicateSummaries,
    evaluateReconciledStructuralExactPair,
  } = auditModule();
  if (
    left.contentFingerprint &&
    left.contentFingerprint === right.contentFingerprint
  ) {
    return true;
  }
  if (areStructuralExactDuplicateSummaries(left, right)) return true;
  if (evaluateReconciledStructuralExactPair(left, right)) return true;
  return false;
}

/**
 * Conservative occurrence pair gate.
 *
 * Relaxed timestamps (null / cross-year): FAIL CLOSED — basket similarity
 * must not create identity. Merge only via durable HC relations above.
 *
 * Timestamp equality is exact-time evidence only when BOTH sides have
 * precision===second (hasExactTransactionTime). Minute / date / unknown
 * never qualify — including generic↔branch pairs.
 */
export function evaluateCanonicalPurchaseOccurrencePair(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): boolean {
  if (existingHcPair(left, right)) return true;
  if (!baseMonetaryCompatible(left, right)) return false;

  const leftExact = left.hasExactTransactionTime && left.transactionAt != null;
  const rightExact = right.hasExactTransactionTime && right.transactionAt != null;
  if (!leftExact || !rightExact) {
    return false;
  }
  if (
    left.transactionTimePrecision !== 'second' ||
    right.transactionTimePrecision !== 'second'
  ) {
    return false;
  }
  if (left.transactionAt !== right.transactionAt) {
    // Cross-year / unequal clocks: fail closed even if baskets match.
    return false;
  }
  return strongNameCompatibleBasketEvidence(left, right);
}

/**
 * Complete-link clustering: merge clusters only when every cross-pair matches.
 * Prevents generic-merchant bridging of conflicting specific branches.
 *
 * When `pairQualified` is provided (prepared evidence), cross-cluster checks use
 * that Boolean relation and do not re-run evaluateCanonicalPurchaseOccurrencePair.
 */
function clusterCompleteLink(
  ids: readonly string[],
  byId: ReadonlyMap<string, AnalysisDDuplicateReceiptSummary>,
  pairQualified?: (a: string, b: string) => boolean
): string[][] {
  const clusters: string[][] = ids.map((id) => [id]);
  const clusterIndex = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 1) {
    clusterIndex.set(ids[i]!, i);
  }

  const isPair = (idA: string, idB: string): boolean => {
    if (pairQualified) return pairQualified(idA, idB);
    return evaluateCanonicalPurchaseOccurrencePair(
      byId.get(idA)!,
      byId.get(idB)!
    );
  };

  const edges: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i]!;
      const b = ids[j]!;
      if (isPair(a, b)) {
        edges.push([a, b]);
      }
    }
  }
  edges.sort(
    (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])
  );

  for (const [a, b] of edges) {
    const ia = clusterIndex.get(a);
    const ib = clusterIndex.get(b);
    if (ia == null || ib == null || ia === ib) continue;

    const clusterA = clusters[ia]!;
    const clusterB = clusters[ib]!;
    let compatible = true;
    for (const idA of clusterA) {
      for (const idB of clusterB) {
        if (!isPair(idA, idB)) {
          compatible = false;
          break;
        }
      }
      if (!compatible) break;
    }
    if (!compatible) continue;

    const merged = [...clusterA, ...clusterB].sort((x, y) =>
      x.localeCompare(y)
    );
    clusters[ia] = merged;
    for (const id of clusterB) {
      clusterIndex.set(id, ia);
    }
    clusters[ib] = [];
  }

  return clusters
    .filter((c) => c.length > 0)
    .map((c) => [...c].sort((x, y) => x.localeCompare(y)))
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function toQualitySummary(
  summary: AnalysisDDuplicateReceiptSummary
): RepresentativeQualitySummary {
  return {
    receiptId: summary.receiptId,
    merchandiseSum: summary.merchandiseSum,
    total: summary.total,
    itemCount: summary.itemCount,
    hasExactTransactionTime: summary.hasExactTransactionTime,
    hasValidTransactionAt: summary.hasValidTransactionAt,
    taxKnown: summary.taxKnown,
    structuralFingerprint: summary.structuralFingerprint,
    createdAt: summary.createdAt,
  };
}

/**
 * Representative selection (truth-independent, deterministic):
 * 1. better amount closure (|merchandiseSum - total|)
 * 2. tax known over tax unknown
 * 3. higher scoreReceiptRepresentativeQuality
 * 4. earlier createdAt (tie-break only — never prefer latest scan)
 * 5. receiptId ASC
 */
export function pickOccurrenceRepresentativeReceiptId(
  memberIds: readonly string[],
  byId: ReadonlyMap<string, AnalysisDDuplicateReceiptSummary>,
  receiptById: ReadonlyMap<string, ReceiptRow>
): string {
  const members = memberIds.map((id) => toQualitySummary(byId.get(id)!));
  return pickBestRepresentativeReceiptId(members, receiptById);
}

/**
 * Preserve the pre-H2.1 Map semantics from commit 444c3ba: duplicate receipt
 * IDs resolve to the LAST ReceiptRow snapshot. Map key insertion order is not
 * authoritative because occurrence IDs are sorted before clustering.
 */
function normalizeCanonicalOccurrenceReceiptUniverse(
  receipts: readonly ReceiptRow[]
): ReceiptRow[] {
  const receiptById = new Map<string, ReceiptRow>();
  for (const receipt of receipts) {
    receiptById.set(receipt.id, receipt);
  }
  return [...receiptById.values()];
}

/**
 * H6.1 — exact SUPERSET of pairs that can evaluate true.
 *
 * True-return paths of evaluateCanonicalPurchaseOccurrencePair:
 * A) non-empty contentFingerprint equality (HC early) — may ignore currency/total/ts
 * B) structural HC — requires both hasExactTransactionTime, precision second,
 *    transactionAt ===, currency, totals, merchant, baskets…
 * C) reconciled HC — requires both hasExactTransactionTime, transactionAt ===,
 *    same merchantKey, totals…
 * D) normal basket path — monetary + both second-exact + transactionAt === + basket
 *
 * Candidate families (union; evaluator remains authoritative):
 * Family fingerprint: same non-empty contentFingerprint
 * Family exactSecondTx: both hasExactTransactionTime && transactionAt != null,
 *   grouped by identical summary.transactionAt (===)
 *
 * No monetary/merchant bucketing (avoids false negatives from moneyEquals /
 * retailer-equivalence divergence across modules).
 */
function addExactOccurrencePairCandidate(
  candidatePairs: Map<string, Set<string>>,
  idA: string,
  idB: string
): void {
  const pair = canonicalizeOccurrencePairIds(idA, idB);
  if (!pair) return;
  const [lo, hi] = pair;
  let bucket = candidatePairs.get(lo);
  if (!bucket) {
    bucket = new Set();
    candidatePairs.set(lo, bucket);
  }
  bucket.add(hi);
}

function addAllPairsWithinGroup(
  candidatePairs: Map<string, Set<string>>,
  group: readonly string[]
): void {
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      addExactOccurrencePairCandidate(candidatePairs, group[i]!, group[j]!);
    }
  }
}

function buildExactOccurrencePairCandidates(
  ids: readonly string[],
  summariesByReceiptId: ReadonlyMap<string, AnalysisDDuplicateReceiptSummary>
): Map<string, Set<string>> {
  const candidatePairs = new Map<string, Set<string>>();

  // Family A — contentFingerprint HC early return.
  const byFingerprint = new Map<string, string[]>();
  for (const id of ids) {
    const fp = summariesByReceiptId.get(id)!.contentFingerprint;
    if (typeof fp !== 'string' || fp.length === 0) continue;
    let group = byFingerprint.get(fp);
    if (!group) {
      group = [];
      byFingerprint.set(fp, group);
    }
    group.push(id);
  }
  for (const group of byFingerprint.values()) {
    if (group.length >= 2) addAllPairsWithinGroup(candidatePairs, group);
  }

  // Family B — structural / reconciled / exact-second basket necessary tx gate.
  const byExactSecondTx = new Map<number, string[]>();
  for (const id of ids) {
    const summary = summariesByReceiptId.get(id)!;
    if (!summary.hasExactTransactionTime || summary.transactionAt == null) {
      continue;
    }
    const tx = summary.transactionAt;
    let group = byExactSecondTx.get(tx);
    if (!group) {
      group = [];
      byExactSecondTx.set(tx, group);
    }
    group.push(id);
  }
  for (const group of byExactSecondTx.values()) {
    if (group.length >= 2) addAllPairsWithinGroup(candidatePairs, group);
  }

  return candidatePairs;
}

function isExactOccurrencePairCandidate(
  candidatePairs: ReadonlyMap<string, ReadonlySet<string>>,
  idA: string,
  idB: string
): boolean {
  const pair = canonicalizeOccurrencePairIds(idA, idB);
  if (!pair) return false;
  const [lo, hi] = pair;
  return candidatePairs.get(lo)?.has(hi) === true;
}

function countNestedPairEntries(
  pairs: ReadonlyMap<string, ReadonlySet<string>>
): number {
  let count = 0;
  for (const bucket of pairs.values()) {
    count += bucket.size;
  }
  return count;
}

/**
 * TEST-ONLY exhaustive all-pairs oracle (independent of H6.1 candidate gen).
 * Returns the nested qualifiedPairs map using the production evaluator.
 */
export function __prepareCanonicalPurchaseOccurrenceEvidenceAllPairsForTests(
  receipts: readonly ReceiptRow[]
): CanonicalPurchaseOccurrencePreparedEvidence {
  const { summarizeReceiptForDuplicateAudit } = auditModule();
  const normalized = normalizeCanonicalOccurrenceReceiptUniverse(receipts);
  const receiptById = new Map<string, ReceiptRow>();
  const summariesByReceiptId = new Map<
    string,
    AnalysisDDuplicateReceiptSummary
  >();
  for (const receipt of normalized) {
    receiptById.set(receipt.id, receipt);
    summariesByReceiptId.set(
      receipt.id,
      summarizeReceiptForDuplicateAudit(receipt)
    );
  }
  const ids = [...summariesByReceiptId.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const qualifiedPairs = new Map<string, Set<string>>();
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const idA = ids[i]!;
      const idB = ids[j]!;
      if (
        evaluateCanonicalPurchaseOccurrencePair(
          summariesByReceiptId.get(idA)!,
          summariesByReceiptId.get(idB)!
        )
      ) {
        const pair = canonicalizeOccurrencePairIds(idA, idB)!;
        const [lo, hi] = pair;
        let bucket = qualifiedPairs.get(lo);
        if (!bucket) {
          bucket = new Set();
          qualifiedPairs.set(lo, bucket);
        }
        bucket.add(hi);
      }
    }
  }
  return { receiptById, summariesByReceiptId, qualifiedPairs };
}

function prepareNormalizedCanonicalPurchaseOccurrenceEvidence(
  receipts: readonly ReceiptRow[]
): CanonicalPurchaseOccurrencePreparedEvidence {
  const { summarizeReceiptForDuplicateAudit } = auditModule();
  const receiptById = new Map<string, ReceiptRow>();
  const summariesByReceiptId = new Map<
    string,
    AnalysisDDuplicateReceiptSummary
  >();
  let summarizeCount = 0;
  for (const receipt of receipts) {
    receiptById.set(receipt.id, receipt);
    summariesByReceiptId.set(
      receipt.id,
      summarizeReceiptForDuplicateAudit(receipt)
    );
    summarizeCount += 1;
  }

  const ids = [...summariesByReceiptId.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  const theoreticalPairCount = (ids.length * (ids.length - 1)) / 2;
  const candidatePairs = buildExactOccurrencePairCandidates(
    ids,
    summariesByReceiptId
  );
  const candidatePairCount = countNestedPairEntries(candidatePairs);

  const qualifiedPairs = new Map<string, Set<string>>();
  let pairEvaluationCount = 0;
  // Preserve baseline i<j visitation order over localeCompare-sorted ids.
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const idA = ids[i]!;
      const idB = ids[j]!;
      if (!isExactOccurrencePairCandidate(candidatePairs, idA, idB)) {
        continue;
      }
      pairEvaluationCount += 1;
      if (
        evaluateCanonicalPurchaseOccurrencePair(
          summariesByReceiptId.get(idA)!,
          summariesByReceiptId.get(idB)!
        )
      ) {
        const pair = canonicalizeOccurrencePairIds(idA, idB)!;
        const [lo, hi] = pair;
        let bucket = qualifiedPairs.get(lo);
        if (!bucket) {
          bucket = new Set();
          qualifiedPairs.set(lo, bucket);
        }
        bucket.add(hi);
      }
    }
  }

  const qualifiedPairCount = countNestedPairEntries(qualifiedPairs);
  lastPrepareStats = {
    summarizeCount,
    theoreticalPairCount,
    candidatePairCount,
    pairEvaluationCount,
    qualifiedPairCount,
  };

  return {
    receiptById,
    summariesByReceiptId,
    qualifiedPairs,
  };
}

/**
 * Prepare receipt-local summaries + unordered pair Boolean evidence.
 * No clustering, representative selection, or occurrence materialization.
 */
export function prepareCanonicalPurchaseOccurrenceEvidence(
  receipts: readonly ReceiptRow[]
): CanonicalPurchaseOccurrencePreparedEvidence {
  const normalized = normalizeCanonicalOccurrenceReceiptUniverse(receipts);
  return prepareNormalizedCanonicalPurchaseOccurrenceEvidence(normalized);
}

function preparedEvidenceCoversReceipts(
  receipts: readonly ReceiptRow[],
  prepared: CanonicalPurchaseOccurrencePreparedEvidence
): boolean {
  for (const receipt of receipts) {
    if (prepared.receiptById.get(receipt.id) !== receipt) {
      return false;
    }
  }
  return true;
}

function buildCanonicalPurchaseOccurrenceIndexFromPreparedUnchecked(
  receipts: readonly ReceiptRow[],
  preparedEvidence: CanonicalPurchaseOccurrencePreparedEvidence
): CanonicalPurchaseOccurrenceIndex {
  const receiptById = new Map<string, ReceiptRow>();
  for (const receipt of receipts) {
    receiptById.set(receipt.id, receipt);
  }
  const byId = new Map<string, AnalysisDDuplicateReceiptSummary>();
  for (const id of receiptById.keys()) {
    byId.set(id, preparedEvidence.summariesByReceiptId.get(id)!);
  }
  const ids = [...byId.keys()].sort((a, b) => a.localeCompare(b));

  const pairQualified = (a: string, b: string): boolean =>
    isPreparedOccurrencePairQualified(preparedEvidence, a, b);

  const clusters = clusterCompleteLink(ids, byId, pairQualified);

  const occurrenceIdByReceiptId = new Map<string, string>();
  const representativeReceiptIdByOccurrenceId = new Map<string, string>();
  const representativeReceiptIdByReceiptId = new Map<string, string>();
  const groups: CanonicalPurchaseOccurrenceGroup[] = [];

  for (const members of clusters) {
    const occurrenceId = members[0]!;
    const representativeReceiptId = pickOccurrenceRepresentativeReceiptId(
      members,
      byId,
      receiptById
    );
    for (const id of members) {
      occurrenceIdByReceiptId.set(id, occurrenceId);
      representativeReceiptIdByReceiptId.set(id, representativeReceiptId);
    }
    representativeReceiptIdByOccurrenceId.set(
      occurrenceId,
      representativeReceiptId
    );
    groups.push({
      occurrenceId,
      receiptIds: members,
      representativeReceiptId,
    });
  }

  return {
    occurrenceIdByReceiptId,
    representativeReceiptIdByOccurrenceId,
    representativeReceiptIdByReceiptId,
    groups,
  };
}

function buildCanonicalPurchaseOccurrenceIndexFreshNormalized(
  receipts: readonly ReceiptRow[]
): CanonicalPurchaseOccurrenceIndex {
  const prepared = prepareNormalizedCanonicalPurchaseOccurrenceEvidence(
    receipts
  );
  return buildCanonicalPurchaseOccurrenceIndexFromPreparedUnchecked(
    receipts,
    prepared
  );
}

/**
 * Build occurrence index from prepared pair/summary evidence.
 * Always re-clusters and re-selects representatives for the supplied universe.
 * Never projects final clusters/representatives from another universe.
 */
export function buildCanonicalPurchaseOccurrenceIndexFromPrepared(
  receipts: readonly ReceiptRow[],
  preparedEvidence: CanonicalPurchaseOccurrencePreparedEvidence
): CanonicalPurchaseOccurrenceIndex {
  const normalized = normalizeCanonicalOccurrenceReceiptUniverse(receipts);
  if (!preparedEvidenceCoversReceipts(normalized, preparedEvidence)) {
    // One non-recursive fresh fallback for the requested normalized universe.
    return buildCanonicalPurchaseOccurrenceIndexFreshNormalized(normalized);
  }
  return buildCanonicalPurchaseOccurrenceIndexFromPreparedUnchecked(
    normalized,
    preparedEvidence
  );
}

/**
 * Build occurrence index over the provided receipt set (typically analytics-retained).
 * Authoritative public convenience API — prepare then buildFromPrepared.
 */
export function buildCanonicalPurchaseOccurrenceIndex(
  receipts: readonly ReceiptRow[]
): CanonicalPurchaseOccurrenceIndex {
  const normalized = normalizeCanonicalOccurrenceReceiptUniverse(receipts);
  return buildCanonicalPurchaseOccurrenceIndexFreshNormalized(normalized);
}

export function emptyCanonicalPurchaseOccurrenceIndex(): CanonicalPurchaseOccurrenceIndex {
  return {
    occurrenceIdByReceiptId: new Map(),
    representativeReceiptIdByOccurrenceId: new Map(),
    representativeReceiptIdByReceiptId: new Map(),
    groups: [],
  };
}

export function resolveCanonicalPurchaseOccurrenceId(
  receiptId: string,
  index: CanonicalPurchaseOccurrenceIndex | null | undefined
): string {
  const id = typeof receiptId === 'string' ? receiptId.trim() : '';
  if (!id) return id;
  if (!index || index.occurrenceIdByReceiptId.size === 0) return id;
  return index.occurrenceIdByReceiptId.get(id) ?? id;
}

export function resolveOccurrenceRepresentativeReceiptId(
  receiptId: string,
  index: CanonicalPurchaseOccurrenceIndex | null | undefined
): string {
  const id = typeof receiptId === 'string' ? receiptId.trim() : '';
  if (!id) return id;
  if (!index || index.representativeReceiptIdByReceiptId.size === 0) {
    return id;
  }
  return index.representativeReceiptIdByReceiptId.get(id) ?? id;
}

/**
 * Analytics-retained receipts → canonical occurrence representatives +
 * expanded exclusion set (HC excluded ∪ non-representative members).
 * Shared by Home / post-save milestones and Product Detail exclusion builders.
 */
export function applyOccurrenceRepresentativeUniverse(
  analyticsReceipts: readonly ReceiptRow[],
  excludedDuplicateReceiptIds?: ReadonlySet<string> | null
): {
  representativeReceipts: ReceiptRow[];
  excludedReceiptIds: Set<string>;
  occurrenceIndex: CanonicalPurchaseOccurrenceIndex;
} {
  const occurrenceIndex =
    buildCanonicalPurchaseOccurrenceIndex(analyticsReceipts);
  const excludedReceiptIds = new Set(excludedDuplicateReceiptIds ?? []);
  for (const id of collectNonRepresentativeOccurrenceReceiptIds(
    analyticsReceipts,
    occurrenceIndex
  )) {
    excludedReceiptIds.add(id);
  }
  return {
    representativeReceipts: retainOccurrenceRepresentativeReceipts(
      analyticsReceipts,
      occurrenceIndex
    ),
    excludedReceiptIds,
    occurrenceIndex,
  };
}

/**
 * One deterministic representative ReceiptRow per canonical purchase occurrence.
 * Use for visit/spend/receipt-count analytics so rescans do not inflate totals.
 */
export function retainOccurrenceRepresentativeReceipts(
  receipts: readonly ReceiptRow[],
  index?: CanonicalPurchaseOccurrenceIndex | null
): ReceiptRow[] {
  const idx = index ?? buildCanonicalPurchaseOccurrenceIndex(receipts);
  const byId = new Map(receipts.map((r) => [r.id, r]));
  const out: ReceiptRow[] = [];
  for (const group of idx.groups) {
    const row = byId.get(group.representativeReceiptId);
    if (row) out.push(row);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Non-representative occurrence members — exclude from receipt-id aggregates
 * (Product History / Product Detail) after HC analytics exclusions.
 */
export function collectNonRepresentativeOccurrenceReceiptIds(
  receipts: readonly ReceiptRow[],
  index?: CanonicalPurchaseOccurrenceIndex | null
): Set<string> {
  const idx = index ?? buildCanonicalPurchaseOccurrenceIndex(receipts);
  const out = new Set<string>();
  for (const group of idx.groups) {
    for (const id of group.receiptIds) {
      if (id !== group.representativeReceiptId) out.add(id);
    }
  }
  return out;
}

/**
 * True when this receiptId is the representative of its occurrence.
 */
export function isOccurrenceRepresentativeReceipt(
  receiptId: string,
  index: CanonicalPurchaseOccurrenceIndex | null | undefined
): boolean {
  const id = typeof receiptId === 'string' ? receiptId.trim() : '';
  if (!id) return false;
  if (!index || index.representativeReceiptIdByReceiptId.size === 0) {
    return true;
  }
  return index.representativeReceiptIdByReceiptId.get(id) === id;
}
