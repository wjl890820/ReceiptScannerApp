/**
 * Analysis D2-A3 — read-only duplicate / re-scan audit.
 *
 * Domain freeze:
 *   Stored Receipt Record ≠ Unique Real-World Purchase
 *
 * Confidence contract:
 *   CONTENT_EXACT_DUPLICATE — identical content fingerprint (incl. item names)
 *   STRUCTURAL_EXACT_DUPLICATE — merchant + valid transaction_at + total + tax
 *     slot + ordered qty+lineAmount (NO item names); OCR name variance allowed
 *   RECONCILED_STRUCTURAL_EXACT_DUPLICATE — additive high-confidence path for
 *     trailing OCR-artifact rescans: same merchantAnalyticsKey + exact
 *     transaction_at + exact total + exact ordered (qty,amount) PREFIX where
 *     the shorter/core vector merchandise-sum equals total, trailing extras
 *     exactly explain overage (>0), and when both taxes are known & differ,
 *     abs(taxA-taxB)===overage. Trailing-prefix only (no arbitrary deletion).
 *     No header-only dedupe. No product-name / fuzzy / AI matching.
 *   SEMANTIC_RESCAN_EXACT_DUPLICATE — additive high-confidence path for
 *     same physical transaction with OCR quantity/spec interpretation
 *     disagreement: same merchantAnalyticsKey + exact clock transaction_at +
 *     exact total + same item count + identical ordered LINE AMOUNT vector +
 *     conservative item-name compatibility + tax compatibility
 *     (both known → tax must match; one known/one unknown → allowed;
 *     both known & different → reject). Does NOT average quantities or merge
 *     item truth — only groups observations and retains disagreement evidence.
 *   PROBABLE_DUPLICATE — weaker than structural (V1: empty; not excluded)
 *   NOT_ENOUGH_EVIDENCE — insufficient for high-confidence dedupe
 *
 * Grouping (A1.3.1): ALL-PAIRS / complete-link invariant.
 * Candidate duplicate pair links (CONTENT / STRUCTURAL / RECONCILED / SEMANTIC)
 * are relationships only — never transitive Union-Find merges.
 * A receipt joins a group only when it has a valid high-confidence relation
 * with EVERY existing member. Deterministic: seed/candidate order by receiptId.
 *
 * Representative rule (SSOT): lib/receiptRepresentativeQuality.ts
 *   scoreReceiptRepresentativeQuality / pickBestRepresentativeReceiptId
 *   Used by duplicate audit, analytics selection, and canonical foundation.
 *   Does not merge receipt contents — only chooses which stored receipt
 *   contributes to analytics.
 *
 * V1 policy: B_EXCLUDE_CONTENT_AND_STRUCTURAL_EXACT
 *   Exclude CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED_STRUCTURAL_EXACT
 *   + SEMANTIC_RESCAN_EXACT extras.
 *   Do NOT exclude PROBABLE / NOT_ENOUGH_EVIDENCE.
 *
 * Collision / safety notes:
 *   - Same merchant + calendar day + total is NOT sufficient.
 *   - Same merchant + total + items with different transaction_at → distinct.
 *   - Missing/invalid transaction_at → never high-confidence dedupe.
 *   - Date-only midnight is NOT exact-time evidence (blocks SEMANTIC_RESCAN).
 *   - created_at is ignored by fingerprints (scan time ≠ purchase identity).
 *   - No register/order number exists reliably in the domain model today;
 *     fingerprints do not invent OCR heuristics for register/order ids.
 *   - Optional keepSeparateReceiptIds (on selection/audit) is a future
 *     KEEP_SEPARATE override so two structurally identical purchases can both
 *     count — no UI in D2-A3.
 *   - No fuzzy / approximate string matching.
 *   - Never deletes, merges, or mutates receipts.
 */

import {
  buildAnalysisDReport,
  type AnalysisDReport,
} from './analysisDReport';
import type { ReceiptRow } from './db';
import { merchantAnalyticsKey } from './merchantAnalytics';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { getReceiptItems } from './receiptItems';
import { parseProductSpecification } from './productSpecification';
import { pickBestRepresentativeReceiptId } from './receiptRepresentativeQuality';

export const ANALYSIS_D_DUPLICATE_AUDIT_VERSION =
  'meruno-analysis-d-duplicate-audit-v7' as const;

export type AnalysisDDuplicateConfidence =
  | 'CONTENT_EXACT_DUPLICATE'
  | 'STRUCTURAL_EXACT_DUPLICATE'
  | 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
  | 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
  | 'PROBABLE_DUPLICATE'
  | 'NOT_ENOUGH_EVIDENCE';

export type AnalysisDDuplicateItemEvidence = {
  nameCanonical: string;
  quantity: number;
  lineAmount: number;
};

export type AnalysisDQtyAmountRow = {
  quantity: number;
  lineAmount: number;
};

export type AnalysisDDuplicateReceiptSummary = {
  receiptId: string;
  merchantKey: string;
  merchantLabel: string;
  transactionAt: number | null;
  hasValidTransactionAt: boolean;
  /** False for date-only midnight — not exact-time evidence. */
  hasExactTransactionTime: boolean;
  total: number;
  tax: number | null;
  taxKnown: boolean;
  itemCount: number;
  createdAt: number;
  /** Content fingerprint (includes item names). Alias field: exactFingerprint. */
  contentFingerprint: string | null;
  /** Back-compat alias of contentFingerprint. */
  exactFingerprint: string | null;
  structuralFingerprint: string | null;
  /** Ordered (qty, effective/line amount) vector — structural/reconciled evidence. */
  orderedQtyAmountVector: AnalysisDQtyAmountRow[];
  /** Ordered canonical item names (SEMANTIC_RESCAN name compatibility). */
  orderedNameCanonicals: string[];
  /** Sum of orderedQtyAmountVector line amounts. */
  merchandiseSum: number;
  /** Normalized currency for structural duplicate guards (explicit only). */
  currency: string | null;
  /** Fail-closed eligibility for order-insensitive structural duplicate matching. */
  structuralDuplicateEligible: boolean;
  /** Canonical raw-validated qty/amount basket for structural duplicate matching. */
  canonicalStructuralBasket: AnalysisDQtyAmountRow[];
};

export type AnalysisDReconciledStructuralEvidence = {
  coreReceiptId: string;
  noisyReceiptIds: string[];
  sharedExactCoreVector: AnalysisDQtyAmountRow[];
  trailingExtraCount: number;
  trailingExtraAmount: number;
  coreMerchandiseSum: number;
  noisyMerchandiseSum: number;
  total: number;
  taxDelta: number | null;
  representativeReceiptId: string;
};

export type AnalysisDSemanticRescanQuantityConflict = {
  leftReceiptId: string;
  rightReceiptId: string;
  itemIndex: number;
  leftQuantity: number;
  rightQuantity: number;
  lineAmount: number;
  leftNameCanonical: string;
  rightNameCanonical: string;
};

export type AnalysisDSemanticRescanTaxCompatibility =
  | 'both_known_equal'
  | 'one_known_one_unknown'
  | 'both_unknown';

/**
 * Group-level semantic summary only.
 * Tax compatibility is pair-level — see relationEvidence[].semanticRescanEvidence.
 */
export type AnalysisDSemanticRescanEvidence = {
  quantityConflicts: AnalysisDSemanticRescanQuantityConflict[];
  nameCompatibilityNotes: string[];
  representativeReceiptId: string;
};

/** Pair-level semantic evidence (authoritative taxCompatibility lives here). */
export type AnalysisDSemanticRescanRelationEvidence =
  AnalysisDSemanticRescanEvidence & {
    taxCompatibility: AnalysisDSemanticRescanTaxCompatibility;
  };

/** One high-confidence duplicate relation between two observations. */
export type AnalysisDDuplicateRelationEvidence = {
  leftReceiptId: string;
  rightReceiptId: string;
  path: Extract<
    AnalysisDDuplicateConfidence,
    | 'CONTENT_EXACT_DUPLICATE'
    | 'STRUCTURAL_EXACT_DUPLICATE'
    | 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
    | 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
  >;
  evidence: string[];
  semanticRescanEvidence?: AnalysisDSemanticRescanRelationEvidence;
  reconciledEvidence?: AnalysisDReconciledStructuralEvidence;
};

export type AnalysisDDuplicateGroup = {
  confidence: AnalysisDDuplicateConfidence;
  fingerprint: string;
  receiptIds: string[];
  representativeReceiptId: string;
  merchant: string;
  transactionAt: number | null;
  total: number;
  itemCount: number;
  matchingEvidence: string[];
  differenceEvidence: string[];
  members: AnalysisDDuplicateReceiptSummary[];
  /** All actual pair links that justify membership (not just group summary). */
  relationEvidence: AnalysisDDuplicateRelationEvidence[];
  reconciledEvidence?: AnalysisDReconciledStructuralEvidence;
  semanticRescanEvidence?: AnalysisDSemanticRescanEvidence;
};

export type AnalysisDDuplicateImpactMetrics = {
  storedReceiptCount: number;
  v1SupportedReceiptCount: number;
  supportedSpend: number;
  merchantVisitCount: number;
  topMerchants: Array<{ merchant: string; visitCount: number; spend: number }>;
  itemOccurrenceCount: number;
  frequentProductCount: number;
  priceHistoryObservationCount: number;
  trend7dSampleSize: number;
  trend30dSampleSize: number;
  categoryCompositionTotal: number;
  activeCategoryRowAmountSum: number;
  categoryConservationGap: number;
};

export type AnalysisDKnownStructuralDuplicateCase = {
  id: 'costco_2023_07_06_9534';
  merchantNeedle: string;
  transactionAtLabel: string;
  total: number;
  storedScanCount: number;
  /** High-confidence purchase candidates after CONTENT/STRUCTURAL/RECONCILED. */
  purchaseCandidateCount: number;
  /** @deprecated alias of purchaseCandidateCount (kept for older diagnostics readers). */
  structuralPurchaseCandidateCount: number;
  receiptIds: string[];
  note: string;
  reconciledConfidence: AnalysisDDuplicateConfidence | null;
  reconciledEvidence: AnalysisDReconciledStructuralEvidence | null;
};

export type AnalysisDSweetPotatoAudit = {
  matchedReceiptIds: string[];
  matchedItemLineCount: number;
  /** Distinct stored receipt rows that matched. */
  storedReceiptCount: number;
  /** Distinct high-confidence purchase candidates among matches. */
  purchaseCandidateCount: number;
  interpretation:
    | 'SAME_RECEIPT_SCANNED_TWICE'
    | 'SAME_PURCHASE_CANDIDATE_MULTIPLE_SCANS'
    | 'TWO_ITEM_LINES_ON_ONE_RECEIPT'
    | 'TWO_DISTINCT_STORED_RECEIPTS'
    | 'MIXED_OR_UNCLEAR'
    | 'NOT_FOUND';
  notes: string[];
  /**
   * Broad ¥698 sweet-potato line audit only. Distinct Costco purchases on
   * other dates remain separate; do not treat all sweet-potato rows as one group.
   */
  scopeNote: string;
};

export type AnalysisDDuplicateScanAudit = {
  auditVersion: typeof ANALYSIS_D_DUPLICATE_AUDIT_VERSION;
  storedReceiptCount: number;
  analyticsPurchaseCandidateCount: number;
  contentExactDuplicateExtras: number;
  structuralExactDuplicateExtras: number;
  reconciledStructuralExactDuplicateExtras: number;
  semanticRescanExactDuplicateExtras: number;
  probableDuplicateExtras: number;
  /** CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED + SEMANTIC_RESCAN extras. */
  highConfidenceDuplicateExtras: number;
  duplicateGroupCount: number;
  notEnoughEvidencePairCount: number;
  missingTransactionAtReceiptCount: number;
  recommendedV1AnalyticsPolicy:
    | 'A_COUNT_ALL'
    | 'B_EXCLUDE_CONTENT_AND_STRUCTURAL_EXACT'
    | 'C_EXCLUDE_INCLUDING_PROBABLE';
  recommendedExcludeHighConfidenceDuplicatesFromV1Analytics: boolean;
  collisionRiskNotes: string[];
  sweetPotatoAudit: AnalysisDSweetPotatoAudit;
  knownStructuralDuplicateCases: AnalysisDKnownStructuralDuplicateCase[];
  groups: AnalysisDDuplicateGroup[];
  impact: {
    before: AnalysisDDuplicateImpactMetrics;
    highConfidenceDeduped: AnalysisDDuplicateImpactMetrics;
    delta: {
      storedReceiptCount: number;
      v1SupportedReceiptCount: number;
      supportedSpend: number;
      merchantVisitCount: number;
      itemOccurrenceCount: number;
      frequentProductCount: number;
      priceHistoryObservationCount: number;
      trend7dSampleSize: number;
      trend30dSampleSize: number;
      categoryCompositionTotal: number;
    };
  };
  policyNotes: string[];
};

/** Deterministic name canonicalize — trim/case/whitespace only (not approximate). */
export function canonicalizeReceiptItemName(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function hasValidTransactionAt(receipt: ReceiptRow): boolean {
  const t = receipt.transaction_at;
  return typeof t === 'number' && Number.isFinite(t) && t > 0;
}

/**
 * True when transaction_at carries clock-time evidence.
 * Date-only parsers emit Asia/Tokyo midnight (00:00:00) — that is NOT exact time.
 */
export function hasExactTransactionTime(receipt: ReceiptRow): boolean {
  if (!hasValidTransactionAt(receipt)) return false;
  const t = receipt.transaction_at as number;
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
    const second = parts.find((p) => p.type === 'second')?.value ?? '';
    if (hour === '00' && minute === '00' && second === '00') {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}


function asItemRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>)
    : {};
}

function readItemName(item: Record<string, unknown>): string {
  for (const key of [
    'name',
    'raw_name',
    'normalized_full_name',
    'canonical_product_name',
  ]) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readItemQuantity(item: Record<string, unknown>): number {
  const q = item.quantity;
  if (typeof q === 'number' && Number.isFinite(q) && q > 0) return q;
  return 1;
}

function readRawItemQuantity(item: Record<string, unknown>): number | null {
  const q = item.quantity;
  if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) return null;
  return q;
}

function readRawItemLineAmount(item: Record<string, unknown>): number | null {
  const lineTotal = item.lineTotal;
  if (typeof lineTotal === 'number' && Number.isFinite(lineTotal) && lineTotal > 0) {
    return lineTotal;
  }
  const line_total = item.line_total;
  if (
    typeof line_total === 'number' &&
    Number.isFinite(line_total) &&
    line_total > 0
  ) {
    return line_total;
  }
  return null;
}

/** Explicit normalized currency for structural duplicate matching (no blank-as-JPY). */
export function normalizeStructuralDuplicateCurrency(
  value: unknown
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '¥' || trimmed === '￥') return 'JPY';
  return trimmed.toUpperCase();
}

export function isExplicitStructuralDuplicateJpyReceipt(
  receipt: Pick<ReceiptRow, 'currency'>
): boolean {
  return normalizeStructuralDuplicateCurrency(receipt.currency) === 'JPY';
}

function isValidStructuralDuplicateTotal(total: unknown): boolean {
  const value = Number(total);
  return Number.isFinite(value) && value > 0;
}

/** Raw basket elements without quantity/amount coercion defaults. */
export function extractRawStructuralBasketElements(
  receipt: ReceiptRow
): AnalysisDQtyAmountRow[] | null {
  const items = getReceiptItems(receipt);
  if (items.length === 0) return null;
  const rows: AnalysisDQtyAmountRow[] = [];
  for (const raw of items) {
    const item = asItemRecord(raw);
    const quantity = readRawItemQuantity(item);
    const lineAmount = readRawItemLineAmount(item);
    if (quantity == null || lineAmount == null) return null;
    rows.push({ quantity, lineAmount });
  }
  return rows;
}

export function assessStructuralDuplicateReceiptEligibility(receipt: ReceiptRow): {
  eligible: boolean;
  currency: string | null;
  canonicalStructuralBasket: AnalysisDQtyAmountRow[];
} {
  const currency = normalizeStructuralDuplicateCurrency(receipt.currency);
  if (currency !== 'JPY') {
    return { eligible: false, currency, canonicalStructuralBasket: [] };
  }
  if (!hasExactTransactionTime(receipt)) {
    return { eligible: false, currency, canonicalStructuralBasket: [] };
  }
  if (!isValidStructuralDuplicateTotal(receipt.total)) {
    return { eligible: false, currency, canonicalStructuralBasket: [] };
  }
  const rawBasket = extractRawStructuralBasketElements(receipt);
  if (rawBasket == null || rawBasket.length === 0) {
    return { eligible: false, currency, canonicalStructuralBasket: [] };
  }
  const canonicalStructuralBasket = canonicalStructuralQtyAmountVector(rawBasket);
  if (canonicalStructuralBasket.length === 0) {
    return { eligible: false, currency, canonicalStructuralBasket: [] };
  }
  return { eligible: true, currency, canonicalStructuralBasket };
}

function roundMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return (Math.round(n * 100) / 100).toFixed(2);
}

function taxSlot(receipt: ReceiptRow): { known: boolean; value: number | null } {
  const known = receipt.tax_is_known === 1;
  if (!known) return { known: false, value: null };
  const raw = receipt.tax;
  if (raw == null) return { known: true, value: null };
  const tax = typeof raw === 'number' ? raw : Number(raw);
  return { known: true, value: Number.isFinite(tax) ? tax : null };
}

export function extractDuplicateItemEvidence(
  receipt: ReceiptRow
): AnalysisDDuplicateItemEvidence[] {
  return getReceiptItems(receipt).map((raw) => {
    const item = asItemRecord(raw);
    return {
      nameCanonical: canonicalizeReceiptItemName(readItemName(item)),
      quantity: readItemQuantity(item),
      lineAmount: itemAmountForAnalytics(item as never),
    };
  });
}

/**
 * Content (exact) receipt fingerprint — includes canonicalized item names.
 * Independent of receipt id and created_at.
 * Requires valid transaction_at — otherwise null (conservative).
 */
export function buildContentReceiptFingerprint(
  receipt: ReceiptRow
): string | null {
  if (!hasExactTransactionTime(receipt)) return null;
  const merchant = merchantAnalyticsKey(receipt);
  const tax = taxSlot(receipt);
  const items = extractDuplicateItemEvidence(receipt);
  const itemPart = items
    .map(
      (it) =>
        `${it.nameCanonical}\u001f${it.quantity}\u001f${roundMoney(it.lineAmount)}`
    )
    .join('\u001e');
  return [
    'v1',
    merchant,
    String(receipt.transaction_at),
    roundMoney(Number(receipt.total) || 0),
    tax.known ? `tax:${roundMoney(tax.value ?? 0)}` : 'tax:unknown',
    `items:${itemPart}`,
  ].join('|');
}

/**
 * Back-compat alias of buildContentReceiptFingerprint.
 */
export function buildExactReceiptFingerprint(
  receipt: ReceiptRow
): string | null {
  return buildContentReceiptFingerprint(receipt);
}

/**
 * Structural fingerprint (merchant/time/total/tax/qty+amount sequence).
 * Item OCR names are intentionally omitted — OCR variance must not block
 * high-confidence same-purchase detection.
 */
export function buildStructuralReceiptFingerprint(
  receipt: ReceiptRow
): string | null {
  const eligibility = assessStructuralDuplicateReceiptEligibility(receipt);
  if (!eligibility.eligible) return null;
  const merchant = merchantAnalyticsKey(receipt);
  const tax = taxSlot(receipt);
  const canonicalRows = eligibility.canonicalStructuralBasket;
  const itemPart = canonicalRows
    .map((it) => `${it.quantity}\u001f${roundMoney(it.lineAmount)}`)
    .join('\u001e');
  return [
    'struct-v1',
    merchant,
    String(receipt.transaction_at),
    roundMoney(Number(receipt.total) || 0),
    tax.known ? `tax:${roundMoney(tax.value ?? 0)}` : 'tax:unknown',
    `n:${canonicalRows.length}`,
    `amt:${itemPart}`,
  ].join('|');
}

export function summarizeReceiptForDuplicateAudit(
  receipt: ReceiptRow
): AnalysisDDuplicateReceiptSummary {
  const items = extractDuplicateItemEvidence(receipt);
  const tax = taxSlot(receipt);
  const structuralEligibility = assessStructuralDuplicateReceiptEligibility(receipt);
  const contentFingerprint = buildContentReceiptFingerprint(receipt);
  const orderedQtyAmountVector = items.map((it) => ({
    quantity: it.quantity,
    lineAmount: it.lineAmount,
  }));
  const merchandiseSum = orderedQtyAmountVector.reduce(
    (sum, row) => sum + row.lineAmount,
    0
  );
  return {
    receiptId: receipt.id,
    merchantKey: merchantAnalyticsKey(receipt),
    merchantLabel:
      receipt.merchant_normalized ||
      receipt.merchant_raw ||
      merchantAnalyticsKey(receipt),
    transactionAt: hasValidTransactionAt(receipt)
      ? receipt.transaction_at
      : null,
    hasValidTransactionAt: hasValidTransactionAt(receipt),
    hasExactTransactionTime: hasExactTransactionTime(receipt),
    total: Number(receipt.total) || 0,
    tax: tax.value,
    taxKnown: tax.known,
    itemCount: items.length,
    createdAt: receipt.created_at,
    contentFingerprint,
    exactFingerprint: contentFingerprint,
    structuralFingerprint: buildStructuralReceiptFingerprint(receipt),
    orderedQtyAmountVector,
    orderedNameCanonicals: items.map((it) => it.nameCanonical),
    merchandiseSum,
    currency: structuralEligibility.currency,
    structuralDuplicateEligible: structuralEligibility.eligible,
    canonicalStructuralBasket: structuralEligibility.canonicalStructuralBasket,
  };
}

/**
 * Deterministic representative: earliest created_at, then receipt id ASC.
 * @deprecated Prefer pickBestRepresentativeReceiptId (SSOT) for groups.
 */
export function pickDuplicateRepresentative(
  members: AnalysisDDuplicateReceiptSummary[]
): string {
  const sorted = [...members].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.receiptId.localeCompare(b.receiptId);
  });
  return sorted[0]!.receiptId;
}

function moneyEquals(a: number, b: number): boolean {
  return roundMoney(a) === roundMoney(b);
}

function qtyAmountRowEquals(
  a: AnalysisDQtyAmountRow,
  b: AnalysisDQtyAmountRow
): boolean {
  return a.quantity === b.quantity && moneyEquals(a.lineAmount, b.lineAmount);
}

function qtyAmountVectorEquals(
  a: readonly AnalysisDQtyAmountRow[],
  b: readonly AnalysisDQtyAmountRow[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!qtyAmountRowEquals(a[i]!, b[i]!)) return false;
  }
  return true;
}

/** Canonical order-insensitive qty/amount vector for structural duplicate evidence. */
export function canonicalStructuralQtyAmountVector(
  rows: readonly AnalysisDQtyAmountRow[]
): AnalysisDQtyAmountRow[] {
  return [...rows].sort((left, right) => {
    const leftAmount = roundMoney(left.lineAmount);
    const rightAmount = roundMoney(right.lineAmount);
    if (leftAmount !== rightAmount) {
      return leftAmount.localeCompare(rightAmount);
    }
    return left.quantity - right.quantity;
  });
}

function areStructuralTaxSlotsCompatible(
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

export function hasValidKnownStructuralDuplicateTax(
  summary: AnalysisDDuplicateReceiptSummary
): boolean {
  return (
    summary.taxKnown && summary.tax != null && Number.isFinite(summary.tax)
  );
}

/**
 * Structural exact duplicate gate beyond raw fingerprint equality.
 * Handles OCR item-order variance and one-sided unknown tax on rescans.
 */
export function areStructuralExactDuplicateSummaries(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): boolean {
  if (!left.structuralDuplicateEligible || !right.structuralDuplicateEligible) {
    return false;
  }
  if (!left.currency || left.currency !== right.currency) return false;
  if (!left.hasExactTransactionTime || !right.hasExactTransactionTime) return false;
  if (!left.merchantKey || left.merchantKey !== right.merchantKey) return false;
  if (left.transactionAt == null || left.transactionAt !== right.transactionAt) {
    return false;
  }
  if (
    !isValidStructuralDuplicateTotal(left.total) ||
    !isValidStructuralDuplicateTotal(right.total)
  ) {
    return false;
  }
  if (!moneyEquals(left.total, right.total)) return false;
  if (
    left.canonicalStructuralBasket.length === 0 ||
    right.canonicalStructuralBasket.length === 0
  ) {
    return false;
  }
  if (!areStructuralTaxSlotsCompatible(left, right)) return false;
  return qtyAmountVectorEquals(
    left.canonicalStructuralBasket,
    right.canonicalStructuralBasket
  );
}

function sumQtyAmountVector(rows: readonly AnalysisDQtyAmountRow[]): number {
  return rows.reduce((sum, row) => sum + row.lineAmount, 0);
}

/**
 * RECONCILED_STRUCTURAL_EXACT pair gate (trailing-prefix V1 only).
 * No header-only matching. No product-name / fuzzy comparison.
 */
export function evaluateReconciledStructuralExactPair(
  a: AnalysisDDuplicateReceiptSummary,
  b: AnalysisDDuplicateReceiptSummary
): {
  core: AnalysisDDuplicateReceiptSummary;
  noisy: AnalysisDDuplicateReceiptSummary;
  trailingExtraCount: number;
  trailingExtraAmount: number;
  overage: number;
  taxDelta: number | null;
} | null {
  // Date-only midnight is not exact-time evidence (same rule as primary fingerprints).
  if (!a.hasExactTransactionTime || !b.hasExactTransactionTime) return null;
  if (!a.merchantKey || a.merchantKey !== b.merchantKey) return null;
  if (a.transactionAt == null || a.transactionAt !== b.transactionAt) return null;
  if (!moneyEquals(a.total, b.total)) return null;

  let core = a;
  let noisy = b;
  if (a.orderedQtyAmountVector.length > b.orderedQtyAmountVector.length) {
    core = b;
    noisy = a;
  } else if (a.orderedQtyAmountVector.length === b.orderedQtyAmountVector.length) {
    return null;
  }

  const coreVec = core.orderedQtyAmountVector;
  const noisyVec = noisy.orderedQtyAmountVector;
  if (coreVec.length === 0) return null;
  if (!qtyAmountVectorEquals(coreVec, noisyVec.slice(0, coreVec.length))) {
    return null;
  }

  const coreSum = sumQtyAmountVector(coreVec);
  if (!moneyEquals(coreSum, core.total)) return null;

  const trailing = noisyVec.slice(coreVec.length);
  const trailingExtraAmount = sumQtyAmountVector(trailing);
  const noisySum = sumQtyAmountVector(noisyVec);
  const overage = noisySum - noisy.total;
  if (!(overage > 0)) return null;
  if (!moneyEquals(trailingExtraAmount, overage)) return null;
  if (!moneyEquals(noisySum - coreSum, overage)) return null;

  let taxDelta: number | null = null;
  if (a.taxKnown && b.taxKnown && a.tax != null && b.tax != null) {
    taxDelta = Math.abs(a.tax - b.tax);
    if (taxDelta > 0 && !moneyEquals(taxDelta, overage)) return null;
  }

  return {
    core,
    noisy,
    trailingExtraCount: trailing.length,
    trailingExtraAmount,
    overage,
    taxDelta,
  };
}

/**
 * Strip trailing pack/count structural tokens for conservative name base compare.
 * Does NOT fuzzy-match product names — only structural quantity/spec suffixes.
 */
export function stripStructuralPackCountSuffix(canonicalName: string): string {
  let s = canonicalName.trim();
  const suffix =
    /(?:\s*[-x×*]\s*\d+(?:\s*(?:個|枚|pc|pcs|pk|pack|count))?|\s+\d+\s*(?:個|枚|pc|pcs|pk|pack|count)(?:入)?|\s+\d+-count)\s*$/i;
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(suffix, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Conservative item-name compatibility for SEMANTIC_RESCAN.
 * Exact canonical match OR same base after stripping pack/count structural tokens
 * OR parseProductSpecification shows only count/pack representation difference
 * on an otherwise identical base. Never fuzzy AI.
 */
export function areSemanticRescanItemNamesCompatible(
  leftNameCanonical: string,
  rightNameCanonical: string
): { compatible: boolean; note: string } {
  const a = leftNameCanonical.trim();
  const b = rightNameCanonical.trim();
  if (!a || !b) {
    return { compatible: false, note: 'empty_item_name' };
  }
  if (a === b) {
    return { compatible: true, note: 'exact_canonical_name' };
  }
  const baseA = stripStructuralPackCountSuffix(a);
  const baseB = stripStructuralPackCountSuffix(b);
  if (baseA && baseB && baseA === baseB) {
    return {
      compatible: true,
      note: 'same_semantic_base_pack_count_token_diff',
    };
  }
  // One name equals the other's stripped base (suffix only on one side).
  if (baseA && baseA === b) {
    return {
      compatible: true,
      note: 'pack_count_suffix_on_left_only',
    };
  }
  if (baseB && baseB === a) {
    return {
      compatible: true,
      note: 'pack_count_suffix_on_right_only',
    };
  }

  // Spec parser: if bases still equal after removing parsed count evidence text.
  const specA = parseProductSpecification(a);
  const specB = parseProductSpecification(b);
  const stripEvidence = (name: string, evidence: string | null): string => {
    if (!evidence) return name;
    const e = canonicalizeReceiptItemName(evidence);
    if (!e) return name;
    return name.replace(e, ' ').replace(/\s+/g, ' ').trim();
  };
  const withoutSpecA = stripStructuralPackCountSuffix(
    stripEvidence(a, specA.sourceText ?? null)
  );
  const withoutSpecB = stripStructuralPackCountSuffix(
    stripEvidence(b, specB.sourceText ?? null)
  );
  if (
    withoutSpecA &&
    withoutSpecB &&
    withoutSpecA === withoutSpecB &&
    (specA.dimension === 'count' ||
      specB.dimension === 'count' ||
      specA.packCount != null ||
      specB.packCount != null)
  ) {
    return {
      compatible: true,
      note: 'spec_parser_count_pack_representation_diff',
    };
  }

  return { compatible: false, note: 'item_name_mismatch' };
}

function lineAmountVectorEquals(
  a: readonly AnalysisDQtyAmountRow[],
  b: readonly AnalysisDQtyAmountRow[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!moneyEquals(a[i]!.lineAmount, b[i]!.lineAmount)) return false;
  }
  return true;
}

/**
 * SEMANTIC_RESCAN_EXACT_DUPLICATE pair gate.
 * Requires exact clock time, merchant, total, item count, ordered line amounts,
 * conservative name compatibility, and tax compatibility.
 * Does not require quantity equality — records quantity disagreements as evidence.
 */
export function evaluateSemanticRescanExactPair(
  a: AnalysisDDuplicateReceiptSummary,
  b: AnalysisDDuplicateReceiptSummary
): {
  quantityConflicts: AnalysisDSemanticRescanQuantityConflict[];
  nameCompatibilityNotes: string[];
  taxCompatibility: AnalysisDSemanticRescanTaxCompatibility;
  leftReceiptId: string;
  rightReceiptId: string;
} | null {
  if (!a.hasExactTransactionTime || !b.hasExactTransactionTime) return null;
  if (!a.merchantKey || a.merchantKey !== b.merchantKey) return null;
  if (a.transactionAt == null || a.transactionAt !== b.transactionAt) return null;
  if (!moneyEquals(a.total, b.total)) return null;
  if (a.itemCount !== b.itemCount) return null;
  if (a.itemCount === 0) return null;
  if (!lineAmountVectorEquals(a.orderedQtyAmountVector, b.orderedQtyAmountVector)) {
    return null;
  }

  // Tax: both known & different → reject; one unknown → allowed.
  if (a.taxKnown && b.taxKnown) {
    if (a.tax == null || b.tax == null) return null;
    if (!moneyEquals(a.tax, b.tax)) return null;
  }

  // Orient left/right by sorted receipt ids — never input order.
  const left = a.receiptId <= b.receiptId ? a : b;
  const right = a.receiptId <= b.receiptId ? b : a;

  const namesLeft = left.orderedNameCanonicals;
  const namesRight = right.orderedNameCanonicals;
  if (
    namesLeft.length !== namesRight.length ||
    namesLeft.length !== left.itemCount
  ) {
    return null;
  }

  const nameCompatibilityNotes: string[] = [];
  for (let i = 0; i < namesLeft.length; i += 1) {
    const check = areSemanticRescanItemNamesCompatible(
      namesLeft[i]!,
      namesRight[i]!
    );
    if (!check.compatible) return null;
    nameCompatibilityNotes.push(
      `pair=${left.receiptId}|${right.receiptId};item_index=${i};${check.note}`
    );
  }

  const quantityConflicts: AnalysisDSemanticRescanQuantityConflict[] = [];
  for (let i = 0; i < left.orderedQtyAmountVector.length; i += 1) {
    const leftQ = left.orderedQtyAmountVector[i]!.quantity;
    const rightQ = right.orderedQtyAmountVector[i]!.quantity;
    if (leftQ !== rightQ) {
      quantityConflicts.push({
        leftReceiptId: left.receiptId,
        rightReceiptId: right.receiptId,
        itemIndex: i,
        leftQuantity: leftQ,
        rightQuantity: rightQ,
        lineAmount: left.orderedQtyAmountVector[i]!.lineAmount,
        leftNameCanonical: namesLeft[i]!,
        rightNameCanonical: namesRight[i]!,
      });
    }
  }

  let taxCompatibility: AnalysisDSemanticRescanTaxCompatibility;
  if (a.taxKnown && b.taxKnown) taxCompatibility = 'both_known_equal';
  else if (!a.taxKnown && !b.taxKnown) taxCompatibility = 'both_unknown';
  else taxCompatibility = 'one_known_one_unknown';

  return {
    quantityConflicts,
    nameCompatibilityNotes,
    taxCompatibility,
    leftReceiptId: left.receiptId,
    rightReceiptId: right.receiptId,
  };
}

/**
 * Reconciled-group representative: merchandise reconciliation quality first,
 * then structural support, then created_at, then receipt id.
 * Never prefer a noisier earlier scan solely because created_at is earlier.
 */
export function pickReconciledDuplicateRepresentative(
  members: AnalysisDDuplicateReceiptSummary[]
): string {
  const structuralSupport = new Map<string, number>();
  for (const m of members) {
    const fp = m.structuralFingerprint;
    if (!fp) continue;
    structuralSupport.set(fp, (structuralSupport.get(fp) ?? 0) + 1);
  }
  const sorted = [...members].sort((a, b) => {
    const da = Math.abs(a.merchandiseSum - a.total);
    const db = Math.abs(b.merchandiseSum - b.total);
    if (da !== db) return da - db;
    const sa = a.structuralFingerprint
      ? structuralSupport.get(a.structuralFingerprint) ?? 0
      : 0;
    const sb = b.structuralFingerprint
      ? structuralSupport.get(b.structuralFingerprint) ?? 0
      : 0;
    if (sa !== sb) return sb - sa;
    if (a.itemCount !== b.itemCount) return a.itemCount - b.itemCount;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.receiptId.localeCompare(b.receiptId);
  });
  return sorted[0]!.receiptId;
}

function pickRepresentative(
  members: AnalysisDDuplicateReceiptSummary[],
  receiptById: ReadonlyMap<string, ReceiptRow>
): string {
  return pickBestRepresentativeReceiptId(members, receiptById);
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u001f${b}` : `${b}\u001f${a}`;
}

const PATH_RANK: Record<
  AnalysisDDuplicateRelationEvidence['path'],
  number
> = {
  CONTENT_EXACT_DUPLICATE: 0,
  STRUCTURAL_EXACT_DUPLICATE: 1,
  RECONCILED_STRUCTURAL_EXACT_DUPLICATE: 2,
  SEMANTIC_RESCAN_EXACT_DUPLICATE: 3,
};

function sortRelationEvidence(
  relations: AnalysisDDuplicateRelationEvidence[]
): AnalysisDDuplicateRelationEvidence[] {
  return [...relations].sort((a, b) => {
    const ra = PATH_RANK[a.path] - PATH_RANK[b.path];
    if (ra !== 0) return ra;
    if (a.leftReceiptId !== b.leftReceiptId) {
      return a.leftReceiptId.localeCompare(b.leftReceiptId);
    }
    return a.rightReceiptId.localeCompare(b.rightReceiptId);
  });
}

function quantityConflictDedupeKey(
  c: AnalysisDSemanticRescanQuantityConflict
): string {
  return [
    c.leftReceiptId,
    c.rightReceiptId,
    String(c.itemIndex),
    String(c.leftQuantity),
    String(c.rightQuantity),
    roundMoney(c.lineAmount),
    c.leftNameCanonical,
    c.rightNameCanonical,
  ].join('\u001f');
}

function sortQuantityConflicts(
  conflicts: AnalysisDSemanticRescanQuantityConflict[]
): AnalysisDSemanticRescanQuantityConflict[] {
  return [...conflicts].sort((a, b) => {
    if (a.leftReceiptId !== b.leftReceiptId) {
      return a.leftReceiptId.localeCompare(b.leftReceiptId);
    }
    if (a.rightReceiptId !== b.rightReceiptId) {
      return a.rightReceiptId.localeCompare(b.rightReceiptId);
    }
    if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
    if (a.leftQuantity !== b.leftQuantity) return a.leftQuantity - b.leftQuantity;
    if (a.rightQuantity !== b.rightQuantity) {
      return a.rightQuantity - b.rightQuantity;
    }
    if (a.lineAmount !== b.lineAmount) return a.lineAmount - b.lineAmount;
    const n = a.leftNameCanonical.localeCompare(b.leftNameCanonical);
    if (n !== 0) return n;
    return a.rightNameCanonical.localeCompare(b.rightNameCanonical);
  });
}

function dedupeQuantityConflicts(
  conflicts: AnalysisDSemanticRescanQuantityConflict[]
): AnalysisDSemanticRescanQuantityConflict[] {
  const seen = new Set<string>();
  const out: AnalysisDSemanticRescanQuantityConflict[] = [];
  for (const c of sortQuantityConflicts(conflicts)) {
    const key = quantityConflictDedupeKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

type InternalPairRelation = AnalysisDDuplicateRelationEvidence & {
  reconciledLink?: NonNullable<
    ReturnType<typeof evaluateReconciledStructuralExactPair>
  >;
};

function buildPairRelation(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): InternalPairRelation | null {
  const leftId = left.receiptId <= right.receiptId ? left.receiptId : right.receiptId;
  const rightId = left.receiptId <= right.receiptId ? right.receiptId : left.receiptId;
  const L = left.receiptId <= right.receiptId ? left : right;
  const R = left.receiptId <= right.receiptId ? right : left;

  if (
    L.contentFingerprint &&
    L.contentFingerprint === R.contentFingerprint
  ) {
    return {
      leftReceiptId: leftId,
      rightReceiptId: rightId,
      path: 'CONTENT_EXACT_DUPLICATE',
      evidence: [
        'identical_content_fingerprint',
        'merchant',
        'transaction_at',
        'total',
        'tax_slot',
        'ordered_item_name_qty_amount',
      ],
    };
  }

  if (areStructuralExactDuplicateSummaries(L, R)) {
    const identicalFingerprint =
      Boolean(L.structuralFingerprint) &&
      L.structuralFingerprint === R.structuralFingerprint;
    return {
      leftReceiptId: leftId,
      rightReceiptId: rightId,
      path: 'STRUCTURAL_EXACT_DUPLICATE',
      evidence: identicalFingerprint
        ? [
            'identical_structural_fingerprint',
            'merchant',
            'transaction_at',
            'total',
            'tax_slot',
            'ordered_qty_amount_structure',
          ]
        : [
            'canonical_structural_qty_amount_match',
            'merchant',
            'transaction_at',
            'total',
            'compatible_tax_slot',
            'ordered_qty_amount_structure',
          ],
    };
  }

  const reconciled = evaluateReconciledStructuralExactPair(L, R);
  if (reconciled) {
    const taxDelta = reconciled.taxDelta;
    return {
      leftReceiptId: leftId,
      rightReceiptId: rightId,
      path: 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE',
      evidence: [
        'reconciled_structural_exact_duplicate',
        'same_merchant_analytics_key',
        'exact_transaction_at',
        'exact_total',
        'exact_ordered_qty_amount_prefix',
        'core_merchandise_sum_equals_total',
        'trailing_extras_explain_overage',
        ...(taxDelta != null && taxDelta > 0 ? ['tax_delta_equals_overage'] : []),
      ],
      reconciledLink: reconciled,
      reconciledEvidence: {
        coreReceiptId: reconciled.core.receiptId,
        noisyReceiptIds: [reconciled.noisy.receiptId],
        sharedExactCoreVector: reconciled.core.orderedQtyAmountVector.map((r) => ({
          quantity: r.quantity,
          lineAmount: r.lineAmount,
        })),
        trailingExtraCount: reconciled.trailingExtraCount,
        trailingExtraAmount: reconciled.trailingExtraAmount,
        coreMerchandiseSum: reconciled.core.merchandiseSum,
        noisyMerchandiseSum: reconciled.noisy.merchandiseSum,
        total: reconciled.core.total,
        taxDelta: reconciled.taxDelta,
        representativeReceiptId: '',
      },
    };
  }

  const semantic = evaluateSemanticRescanExactPair(L, R);
  if (!semantic) return null;

  return {
    leftReceiptId: leftId,
    rightReceiptId: rightId,
    path: 'SEMANTIC_RESCAN_EXACT_DUPLICATE',
    evidence: [
      'semantic_rescan_exact_duplicate',
      'same_merchant_analytics_key',
      'exact_transaction_at',
      'exact_total',
      'same_item_count',
      'exact_ordered_line_amount_vector',
      'conservative_item_name_compatibility',
      `tax_compatibility=${semantic.taxCompatibility}`,
    ],
    semanticRescanEvidence: {
      quantityConflicts: semantic.quantityConflicts,
      nameCompatibilityNotes: semantic.nameCompatibilityNotes,
      taxCompatibility: semantic.taxCompatibility,
      representativeReceiptId: '',
    },
  };
}

/**
 * High-confidence duplicate groups with ALL-PAIRS compatibility (A1.3.1).
 * Never forms a group solely from transitive Union-Find connectivity.
 *
 * Optional `receipts` enables full representative quality SSOT scoring.
 */
export function buildHighConfidenceDuplicateGroups(
  summaries: AnalysisDDuplicateReceiptSummary[],
  receipts?: readonly ReceiptRow[]
): AnalysisDDuplicateGroup[] {
  const receiptById = new Map((receipts ?? []).map((r) => [r.id, r]));
  const byId = new Map(summaries.map((s) => [s.receiptId, s]));
  const sortedIds = [...byId.keys()].sort((a, b) => a.localeCompare(b));

  const relationByPair = new Map<string, InternalPairRelation>();
  for (let i = 0; i < sortedIds.length; i += 1) {
    for (let j = i + 1; j < sortedIds.length; j += 1) {
      const a = byId.get(sortedIds[i]!)!;
      const b = byId.get(sortedIds[j]!)!;
      const rel = buildPairRelation(a, b);
      if (!rel) continue;
      relationByPair.set(pairKey(a.receiptId, b.receiptId), rel);
    }
  }

  // Deterministic greedy complete-link: seed by sorted receiptId.
  const assigned = new Set<string>();
  const clusters: string[][] = [];

  for (const seed of sortedIds) {
    if (assigned.has(seed)) continue;
    const cluster = [seed];
    for (const candidate of sortedIds) {
      if (candidate === seed || assigned.has(candidate)) continue;
      const compatible = cluster.every((member) =>
        relationByPair.has(pairKey(member, candidate))
      );
      if (compatible) cluster.push(candidate);
    }
    if (cluster.length >= 2) {
      for (const id of cluster) assigned.add(id);
      clusters.push(cluster);
    }
  }

  const out: AnalysisDDuplicateGroup[] = [];

  for (const clusterIds of clusters) {
    const members = clusterIds
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.receiptId.localeCompare(b.receiptId));
    const memberIds = members.map((m) => m.receiptId);

    const relations: InternalPairRelation[] = [];
    for (let i = 0; i < memberIds.length; i += 1) {
      for (let j = i + 1; j < memberIds.length; j += 1) {
        const rel = relationByPair.get(pairKey(memberIds[i]!, memberIds[j]!));
        if (rel) relations.push(rel);
      }
    }
    const sortedRelations = sortRelationEvidence(relations);

    const hasReconciled = relations.some(
      (r) => r.path === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
    );
    const hasSemantic = relations.some(
      (r) => r.path === 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
    );

    let confidence: AnalysisDDuplicateConfidence;
    if (hasReconciled) {
      confidence = 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE';
    } else if (hasSemantic) {
      confidence = 'SEMANTIC_RESCAN_EXACT_DUPLICATE';
    } else {
      const allContent = relations.every(
        (r) => r.path === 'CONTENT_EXACT_DUPLICATE'
      );
      confidence = allContent
        ? 'CONTENT_EXACT_DUPLICATE'
        : 'STRUCTURAL_EXACT_DUPLICATE';
    }

    const representativeReceiptId = pickRepresentative(members, receiptById);
    const rep = members.find((m) => m.receiptId === representativeReceiptId)!;

    const relationEvidence: AnalysisDDuplicateRelationEvidence[] =
      sortedRelations.map((r) => {
        const base: AnalysisDDuplicateRelationEvidence = {
          leftReceiptId: r.leftReceiptId,
          rightReceiptId: r.rightReceiptId,
          path: r.path,
          evidence: [...r.evidence],
        };
        if (r.semanticRescanEvidence) {
          base.semanticRescanEvidence = {
            ...r.semanticRescanEvidence,
            representativeReceiptId,
          };
        }
        if (r.reconciledEvidence) {
          base.reconciledEvidence = {
            ...r.reconciledEvidence,
            representativeReceiptId,
          };
        }
        return base;
      });

    let reconciledEvidence: AnalysisDReconciledStructuralEvidence | undefined;
    if (hasReconciled) {
      const reconciledRels = relations.filter(
        (r) =>
          r.path === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE' && r.reconciledLink
      );
      const noisyReceiptIds = [
        ...new Set(
          reconciledRels.map((r) => r.reconciledLink!.noisy.receiptId)
        ),
      ].sort((a, b) => a.localeCompare(b));
      const primary = reconciledRels[0]!.reconciledLink!;
      const core = primary.core;
      reconciledEvidence = {
        coreReceiptId: core.receiptId,
        noisyReceiptIds,
        sharedExactCoreVector: core.orderedQtyAmountVector.map((row) => ({
          quantity: row.quantity,
          lineAmount: row.lineAmount,
        })),
        trailingExtraCount: primary.trailingExtraCount,
        trailingExtraAmount: primary.trailingExtraAmount,
        coreMerchandiseSum: core.merchandiseSum,
        noisyMerchandiseSum: primary.noisy.merchandiseSum,
        total: core.total,
        taxDelta: primary.taxDelta,
        representativeReceiptId,
      };
    }

    let semanticRescanEvidence: AnalysisDSemanticRescanEvidence | undefined;
    if (hasSemantic) {
      const semanticRels = sortRelationEvidence(
        relations.filter(
          (r) =>
            r.path === 'SEMANTIC_RESCAN_EXACT_DUPLICATE' &&
            r.semanticRescanEvidence
        )
      );
      const quantityConflicts = dedupeQuantityConflicts(
        semanticRels.flatMap(
          (r) => r.semanticRescanEvidence!.quantityConflicts
        )
      );
      const nameCompatibilityNotes = stableUnique(
        semanticRels.flatMap(
          (r) => r.semanticRescanEvidence!.nameCompatibilityNotes
        )
      );
      // Tax compatibility is pair-level only (relationEvidence SSOT).
      semanticRescanEvidence = {
        quantityConflicts,
        nameCompatibilityNotes,
        representativeReceiptId,
      };
    }

    let fingerprint: string;
    let matchingEvidence: string[];
    let differenceEvidence: string[];

    if (
      confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE' &&
      reconciledEvidence
    ) {
      const core =
        members.find((m) => m.receiptId === reconciledEvidence.coreReceiptId) ??
        rep;
      fingerprint = [
        'reconciled-struct-v1',
        core.merchantKey,
        String(core.transactionAt),
        roundMoney(core.total),
        `coreN:${core.orderedQtyAmountVector.length}`,
        `coreAmt:${core.orderedQtyAmountVector
          .map((r) => `${r.quantity}\u001f${roundMoney(r.lineAmount)}`)
          .join('\u001e')}`,
      ].join('|');
      matchingEvidence = [
        'reconciled_structural_exact_duplicate',
        'same_merchant_analytics_key',
        'exact_transaction_at',
        'exact_total',
        'exact_ordered_qty_amount_prefix',
        'core_merchandise_sum_equals_total',
        'trailing_extras_explain_overage',
        ...(reconciledEvidence.taxDelta != null &&
        reconciledEvidence.taxDelta > 0
          ? ['tax_delta_equals_overage']
          : []),
        ...(hasSemantic ? ['also_has_semantic_rescan_pair_evidence'] : []),
      ];
      differenceEvidence = [
        `core_receipt_id=${reconciledEvidence.coreReceiptId}`,
        `noisy_receipt_ids=${reconciledEvidence.noisyReceiptIds.join(',')}`,
        `trailing_extra_count=${reconciledEvidence.trailingExtraCount}`,
        `trailing_extra_amount=${roundMoney(
          reconciledEvidence.trailingExtraAmount
        )}`,
        `core_merchandise_sum=${roundMoney(
          reconciledEvidence.coreMerchandiseSum
        )}`,
        `noisy_merchandise_sum=${roundMoney(
          reconciledEvidence.noisyMerchandiseSum
        )}`,
        `total=${roundMoney(reconciledEvidence.total)}`,
        `tax_delta=${
          reconciledEvidence.taxDelta == null
            ? 'n/a'
            : roundMoney(reconciledEvidence.taxDelta)
        }`,
        `representative_receipt_id=${representativeReceiptId}`,
        ...(semanticRescanEvidence?.quantityConflicts.map(
          (c) =>
            `observation_quantity_conflict;left_receipt_id=${c.leftReceiptId};right_receipt_id=${c.rightReceiptId};item_index=${c.itemIndex};left_quantity=${c.leftQuantity};right_quantity=${c.rightQuantity};line_amount=${roundMoney(c.lineAmount)}`
        ) ?? []),
      ];
    } else if (
      confidence === 'SEMANTIC_RESCAN_EXACT_DUPLICATE' &&
      semanticRescanEvidence
    ) {
      const lineAmtKey = members[0]!.orderedQtyAmountVector
        .map((r) => roundMoney(r.lineAmount))
        .join('\u001e');
      fingerprint = [
        'semantic-rescan-v1',
        members[0]!.merchantKey,
        String(members[0]!.transactionAt),
        roundMoney(members[0]!.total),
        `n:${members[0]!.itemCount}`,
        `lineAmt:${lineAmtKey}`,
      ].join('|');
      matchingEvidence = [
        'semantic_rescan_exact_duplicate',
        'same_merchant_analytics_key',
        'exact_transaction_at',
        'exact_total',
        'same_item_count',
        'exact_ordered_line_amount_vector',
        'conservative_item_name_compatibility',
      ];
      differenceEvidence = [
        ...semanticRescanEvidence.quantityConflicts.map(
          (c) =>
            `observation_quantity_conflict;left_receipt_id=${c.leftReceiptId};right_receipt_id=${c.rightReceiptId};item_index=${c.itemIndex};left_quantity=${c.leftQuantity};right_quantity=${c.rightQuantity};line_amount=${roundMoney(c.lineAmount)}`
        ),
        ...semanticRescanEvidence.nameCompatibilityNotes.filter(
          (n) => !n.includes('exact_canonical_name')
        ),
        `representative_receipt_id=${representativeReceiptId}`,
      ].sort();
    } else {
      const allSameContent = confidence === 'CONTENT_EXACT_DUPLICATE';
      const fp =
        members[0]!.structuralFingerprint ??
        members[0]!.contentFingerprint ??
        memberIds.join('|');
      fingerprint = fp;
      matchingEvidence = allSameContent
        ? [
            'identical_content_fingerprint',
            'merchant',
            'transaction_at',
            'total',
            'tax_slot',
            'ordered_item_name_qty_amount',
          ]
        : [
            'identical_structural_fingerprint',
            'merchant',
            'transaction_at',
            'total',
            'tax_slot',
            'ordered_qty_amount_structure',
          ];
      differenceEvidence = allSameContent
        ? members
            .filter((m) => m.receiptId !== representativeReceiptId)
            .map(
              (m) =>
                `receipt_id=${m.receiptId};created_at_delta_ms=${
                  m.createdAt - rep.createdAt
                }`
            )
        : [
            'item_name_canonical_may_differ',
            ...members
              .filter((m) => m.receiptId !== representativeReceiptId)
              .map(
                (m) =>
                  `receipt_id=${m.receiptId};created_at_delta_ms=${
                    m.createdAt - rep.createdAt
                  }`
              ),
          ];
    }

    out.push({
      confidence,
      fingerprint,
      receiptIds: [...memberIds],
      representativeReceiptId,
      merchant: members[0]!.merchantLabel,
      transactionAt: members[0]!.transactionAt,
      total: members[0]!.total,
      itemCount:
        confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
          ? rep.itemCount
          : members[0]!.itemCount,
      matchingEvidence,
      differenceEvidence,
      members,
      relationEvidence,
      ...(reconciledEvidence ? { reconciledEvidence } : {}),
      ...(semanticRescanEvidence ? { semanticRescanEvidence } : {}),
    });
  }

  return out.sort((a, b) => {
    const ca = PATH_RANK[a.confidence as keyof typeof PATH_RANK] ?? 99;
    const cb = PATH_RANK[b.confidence as keyof typeof PATH_RANK] ?? 99;
    if (ca !== cb) return ca - cb;
    if (a.fingerprint !== b.fingerprint) {
      return a.fingerprint.localeCompare(b.fingerprint);
    }
    return a.representativeReceiptId.localeCompare(b.representativeReceiptId);
  });
}

function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...values].sort()) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Content-exact groups only (diagnostic / tests). Prefer structural grouping. */
export function buildExactDuplicateGroups(
  summaries: AnalysisDDuplicateReceiptSummary[]
): AnalysisDDuplicateGroup[] {
  return buildHighConfidenceDuplicateGroups(summaries).filter(
    (g) => g.confidence === 'CONTENT_EXACT_DUPLICATE'
  );
}

/**
 * PROBABLE is reserved for evidence weaker than STRUCTURAL_EXACT.
 * V1: return empty — do not label structural cases as probable.
 */
export function buildProbableDuplicateGroups(
  _summaries: AnalysisDDuplicateReceiptSummary[],
  _exactGroupedIds?: Set<string>
): AnalysisDDuplicateGroup[] {
  return [];
}

function countWeakMerchantDayTotalCollisions(
  summaries: AnalysisDDuplicateReceiptSummary[]
): number {
  const map = new Map<string, number>();
  for (const s of summaries) {
    if (!s.hasValidTransactionAt || s.transactionAt == null) continue;
    const day = new Date(s.transactionAt).toISOString().slice(0, 10);
    const key = `${s.merchantKey}|${day}|${roundMoney(s.total)}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  let pairs = 0;
  for (const n of map.values()) {
    if (n >= 2) pairs += (n * (n - 1)) / 2;
  }
  return pairs;
}

export type DedupSelectionOpts = {
  /** Future KEEP_SEPARATE override — these ids are never dropped. */
  keepSeparateReceiptIds?: ReadonlySet<string>;
};

/**
 * Drop high-confidence duplicate extras (keep one representative per group).
 * Respects optional keepSeparateReceiptIds.
 */
export function selectHighConfidenceDedupedReceipts(
  receipts: ReceiptRow[],
  highConfidenceGroups: AnalysisDDuplicateGroup[],
  opts?: DedupSelectionOpts
): ReceiptRow[] {
  const keepSeparate = opts?.keepSeparateReceiptIds;
  const drop = new Set<string>();
  for (const g of highConfidenceGroups) {
    for (const id of g.receiptIds) {
      if (id === g.representativeReceiptId) continue;
      if (keepSeparate?.has(id)) continue;
      drop.add(id);
    }
  }
  return receipts.filter((r) => !drop.has(r.id));
}

/** Back-compat alias — now uses high-confidence (content + structural) groups. */
export function selectExactDedupedReceipts(
  receipts: ReceiptRow[],
  groups: AnalysisDDuplicateGroup[],
  opts?: DedupSelectionOpts
): ReceiptRow[] {
  return selectHighConfidenceDedupedReceipts(receipts, groups, opts);
}

function metricsFromReport(
  report: AnalysisDReport,
  storedReceiptCount: number
): AnalysisDDuplicateImpactMetrics {
  const allMerchants =
    report.merchants.find((w) => w.window === 'all')?.topMerchants ?? [];
  const merchantVisitCount = allMerchants.reduce(
    (sum, m) => sum + (m.visitCount ?? 0),
    0
  );
  const allFrequent =
    report.frequentProducts.find((w) => w.window === 'all') ?? null;
  const categoryAll =
    report.categoryValue.find((w) => w.window === 'all') ?? null;
  const categoryCompositionTotal = categoryAll?.categoryCompositionTotal ?? 0;
  const activeCategoryRowAmountSum = (categoryAll?.categories ?? []).reduce(
    (sum, c) => sum + (c.amount ?? 0),
    0
  );
  const trend7dSampleSize =
    report.trends.find((t) => t.window === '7d')?.currentReceiptSampleSize ?? 0;
  const trend30dSampleSize =
    report.trends.find((t) => t.window === '30d')?.currentReceiptSampleSize ??
    0;

  return {
    storedReceiptCount,
    v1SupportedReceiptCount: report.dataset.v1SupportedReceiptCount,
    supportedSpend: report.dataset.supportedReceiptSpendTotal,
    merchantVisitCount,
    topMerchants: allMerchants.slice(0, 5).map((m) => ({
      merchant: m.merchant,
      visitCount: m.visitCount,
      spend: m.supportedSpend,
    })),
    itemOccurrenceCount: report.dataset.totalItemRowCount,
    frequentProductCount: allFrequent?.frequentProducts.length ?? 0,
    priceHistoryObservationCount: report.priceCoverage.purchaseUnitPriceUsableRows,
    trend7dSampleSize,
    trend30dSampleSize,
    categoryCompositionTotal,
    activeCategoryRowAmountSum,
    categoryConservationGap:
      categoryCompositionTotal - activeCategoryRowAmountSum,
  };
}

function countPurchaseCandidatesAmongMatched(
  matchedReceiptIds: string[],
  highConfidenceGroups: AnalysisDDuplicateGroup[]
): number {
  if (matchedReceiptIds.length === 0) return 0;
  const matched = new Set(matchedReceiptIds);
  const covered = new Set<string>();
  let candidates = 0;
  for (const g of highConfidenceGroups) {
    const overlap = g.receiptIds.filter((id) => matched.has(id));
    if (overlap.length === 0) continue;
    candidates += 1;
    for (const id of overlap) covered.add(id);
  }
  for (const id of matchedReceiptIds) {
    if (!covered.has(id)) candidates += 1;
  }
  return candidates;
}

export function auditSweetPotatoStyleObservations(
  receipts: ReceiptRow[],
  opts?: {
    merchantNeedle?: RegExp;
    itemNeedle?: RegExp;
    amount?: number;
  }
): AnalysisDSweetPotatoAudit {
  const merchantNeedle = opts?.merchantNeedle ?? /コストコ|costco/i;
  const itemNeedle = opts?.itemNeedle ?? /さつまいも|sweet\s*potato/i;
  const amount = opts?.amount ?? 698;

  const matchedReceiptIds: string[] = [];
  let matchedItemLineCount = 0;
  const notes: string[] = [];

  for (const receipt of receipts) {
    const merchant = `${receipt.merchant_normalized ?? ''} ${
      receipt.merchant_raw ?? ''
    }`;
    if (!merchantNeedle.test(merchant)) continue;
    const items = extractDuplicateItemEvidence(receipt);
    const hits = items.filter(
      (it) =>
        itemNeedle.test(it.nameCanonical) &&
        Math.abs(it.lineAmount - amount) < 0.01
    );
    if (hits.length === 0) continue;
    matchedReceiptIds.push(receipt.id);
    matchedItemLineCount += hits.length;
  }

  const matchedSummaries = receipts
    .filter((r) => matchedReceiptIds.includes(r.id))
    .map(summarizeReceiptForDuplicateAudit);
  const matchedReceipts = receipts.filter((r) =>
    matchedReceiptIds.includes(r.id)
  );
  const highConfidence = buildHighConfidenceDuplicateGroups(
    matchedSummaries,
    matchedReceipts
  );
  const purchaseCandidateCount = countPurchaseCandidatesAmongMatched(
    matchedReceiptIds,
    highConfidence
  );
  const storedReceiptCount = matchedReceiptIds.length;

  let interpretation: AnalysisDSweetPotatoAudit['interpretation'] = 'NOT_FOUND';
  if (matchedReceiptIds.length === 0) {
    notes.push('No Costco sweet-potato ¥698 lines found in provided receipts.');
  } else if (matchedReceiptIds.length === 1 && matchedItemLineCount >= 2) {
    interpretation = 'TWO_ITEM_LINES_ON_ONE_RECEIPT';
    notes.push(
      'Single stored receipt contains multiple matching item lines — Product Detail can show two observations without a re-scan.'
    );
  } else if (
    matchedReceiptIds.length >= 2 &&
    purchaseCandidateCount === 1 &&
    highConfidence.some((g) =>
      matchedReceiptIds.every((id) => g.receiptIds.includes(id))
    )
  ) {
    const conf = highConfidence[0]?.confidence;
    if (conf === 'CONTENT_EXACT_DUPLICATE') {
      interpretation = 'SAME_RECEIPT_SCANNED_TWICE';
      notes.push(
        'Matched receipts share a content fingerprint — likely the same physical receipt scanned twice.'
      );
    } else {
      interpretation = 'SAME_PURCHASE_CANDIDATE_MULTIPLE_SCANS';
      notes.push(
        `Multiple stored receipts (${storedReceiptCount}) collapse to one STRUCTURAL_EXACT purchase candidate — OCR names may differ across scans.`
      );
    }
  } else if (matchedReceiptIds.length >= 2 && purchaseCandidateCount === 1) {
    interpretation = 'SAME_PURCHASE_CANDIDATE_MULTIPLE_SCANS';
    notes.push(
      `Matched stored receipts (${storedReceiptCount}) map to one purchase candidate.`
    );
  } else if (matchedReceiptIds.length >= 2) {
    interpretation = 'TWO_DISTINCT_STORED_RECEIPTS';
    notes.push(
      `Multiple stored receipts matched with ${purchaseCandidateCount} purchase candidates — treat as distinct unless stronger evidence appears.`
    );
  } else {
    interpretation = 'MIXED_OR_UNCLEAR';
  }

  notes.push(
    'Scope: ¥698 sweet-potato line matches only. Legitimate distinct Costco sweet-potato purchases on other dates are not one duplicate group.'
  );

  return {
    matchedReceiptIds,
    matchedItemLineCount,
    storedReceiptCount,
    purchaseCandidateCount,
    interpretation,
    notes,
    scopeNote:
      'Broad sweet-potato ¥698 audit only — not all Costco sweet-potato receipts form one group.',
  };
}

/**
 * Device forensic target receipt ids for the known Costco ¥9534 re-scan case.
 * Single source for D2-E1 export — do not duplicate this list elsewhere.
 */
export const ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS = [
  '2bDvMWs3dkCKagyrYWyxA',
  'C_aMA69ijcqNLhGI76Y5Q',
  'n6_vGM5c8X255Psyiup4k',
  'NEHGZCkqd8MiBCyKO-fWd',
] as const;

export type AnalysisDKnownCostco9534ForensicTargetReceiptId =
  (typeof ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS)[number];

/** Explicit Costco 2023-07-06 11:44 / ¥9534 structural re-scan case. */
export function auditKnownStructuralCostco9534Case(
  receipts: ReceiptRow[]
): AnalysisDKnownStructuralDuplicateCase | null {
  const targetTotal = 9534;
  const merchantNeedle = /コストコ|costco/i;
  const dayStart = Date.parse('2023-07-06T00:00:00+09:00');
  const dayEnd = Date.parse('2023-07-07T00:00:00+09:00');
  const matched = receipts.filter((receipt) => {
    const merchant = `${receipt.merchant_normalized ?? ''} ${
      receipt.merchant_raw ?? ''
    }`;
    if (!merchantNeedle.test(merchant)) return false;
    if (!hasValidTransactionAt(receipt)) return false;
    const at = receipt.transaction_at as number;
    if (at < dayStart || at >= dayEnd) return false;
    return Math.abs(Number(receipt.total) - targetTotal) < 0.01;
  });
  if (matched.length === 0) return null;
  const summaries = matched.map(summarizeReceiptForDuplicateAudit);
  const groups = buildHighConfidenceDuplicateGroups(summaries, matched);
  const structuralPurchaseCandidateCount = countPurchaseCandidatesAmongMatched(
    matched.map((r) => r.id),
    groups
  );
  const reconciledGroup = groups.find(
    (g) =>
      g.confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE' &&
      matched.every((r) => g.receiptIds.includes(r.id))
  ) ?? groups.find(
    (g) =>
      g.confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE' &&
      g.receiptIds.some((id) => matched.some((r) => r.id === id))
  ) ?? null;

  return {
    id: 'costco_2023_07_06_9534',
    merchantNeedle: 'Costco',
    transactionAtLabel: '2023-07-06 11:44',
    total: targetTotal,
    storedScanCount: matched.length,
    purchaseCandidateCount: structuralPurchaseCandidateCount,
    structuralPurchaseCandidateCount,
    receiptIds: matched.map((r) => r.id),
    note:
      'Known structural duplicate validation case: multiple stored scans of one Costco purchase (total ¥9534 @ 2023-07-06 11:44) should collapse to 1 purchase candidate. Separate from the broad sweet-potato ¥698 audit.',
    reconciledConfidence: reconciledGroup?.confidence ?? null,
    reconciledEvidence: reconciledGroup?.reconciledEvidence ?? null,
  };
}

export function buildAnalysisDDuplicateScanAudit(
  receipts: ReceiptRow[],
  nowMs: number = Date.now(),
  opts?: DedupSelectionOpts
): AnalysisDDuplicateScanAudit {
  const summaries = receipts.map(summarizeReceiptForDuplicateAudit);
  const missingTransactionAtReceiptCount = summaries.filter(
    (s) => !s.hasValidTransactionAt
  ).length;

  const highConfidenceGroups = buildHighConfidenceDuplicateGroups(
    summaries,
    receipts
  );
  const probableGroups = buildProbableDuplicateGroups(summaries);

  let contentExactDuplicateExtras = 0;
  let structuralExactDuplicateExtras = 0;
  let reconciledStructuralExactDuplicateExtras = 0;
  let semanticRescanExactDuplicateExtras = 0;
  for (const g of highConfidenceGroups) {
    const extras = Math.max(0, g.receiptIds.length - 1);
    if (g.confidence === 'CONTENT_EXACT_DUPLICATE') {
      contentExactDuplicateExtras += extras;
    } else if (g.confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE') {
      reconciledStructuralExactDuplicateExtras += extras;
    } else if (g.confidence === 'SEMANTIC_RESCAN_EXACT_DUPLICATE') {
      semanticRescanExactDuplicateExtras += extras;
    } else {
      structuralExactDuplicateExtras += extras;
    }
  }
  const probableDuplicateExtras = probableGroups.reduce(
    (sum, g) => sum + Math.max(0, g.receiptIds.length - 1),
    0
  );
  const highConfidenceDuplicateExtras =
    contentExactDuplicateExtras +
    structuralExactDuplicateExtras +
    reconciledStructuralExactDuplicateExtras +
    semanticRescanExactDuplicateExtras;

  const analyticsPurchaseCandidateCount =
    receipts.length - highConfidenceDuplicateExtras;
  const notEnoughEvidencePairCount =
    countWeakMerchantDayTotalCollisions(summaries);

  const dedupedReceipts = selectHighConfidenceDedupedReceipts(
    receipts,
    highConfidenceGroups,
    opts
  );
  const beforeReport = buildAnalysisDReport({ receipts, nowMs });
  const afterReport = buildAnalysisDReport({
    receipts: dedupedReceipts,
    nowMs,
  });
  const before = metricsFromReport(beforeReport, receipts.length);
  const highConfidenceDeduped = metricsFromReport(
    afterReport,
    dedupedReceipts.length
  );

  return {
    auditVersion: ANALYSIS_D_DUPLICATE_AUDIT_VERSION,
    storedReceiptCount: receipts.length,
    analyticsPurchaseCandidateCount,
    contentExactDuplicateExtras,
    structuralExactDuplicateExtras,
    reconciledStructuralExactDuplicateExtras,
    semanticRescanExactDuplicateExtras,
    probableDuplicateExtras,
    highConfidenceDuplicateExtras,
    duplicateGroupCount: highConfidenceGroups.length,
    notEnoughEvidencePairCount,
    missingTransactionAtReceiptCount,
    recommendedV1AnalyticsPolicy: 'B_EXCLUDE_CONTENT_AND_STRUCTURAL_EXACT',
    recommendedExcludeHighConfidenceDuplicatesFromV1Analytics: true,
    collisionRiskNotes: [
      'Same merchant + same calendar day + same total is NOT sufficient for high-confidence duplicate.',
      'Same merchant + total + items with different transaction_at are treated as distinct purchases.',
      'created_at is ignored by content/structural fingerprints (scan time ≠ purchase identity).',
      'Receipts missing valid transaction_at are never content/structural-deduped.',
      'No register/order number is reliably available in the domain model; fingerprints do not invent OCR register heuristics.',
      'PROBABLE is reserved for weaker-than-structural evidence and is empty in V1 (not excluded).',
      'Optional keepSeparateReceiptIds can preserve structurally identical purchases (future KEEP_SEPARATE).',
      `Weak merchant/day/total collision pairs (NOT_ENOUGH_EVIDENCE, informational only): ${notEnoughEvidencePairCount}`,
    ],
    sweetPotatoAudit: auditSweetPotatoStyleObservations(receipts),
    knownStructuralDuplicateCases: [
      auditKnownStructuralCostco9534Case(receipts),
    ].filter((c): c is AnalysisDKnownStructuralDuplicateCase => c != null),
    groups: [...highConfidenceGroups, ...probableGroups],
    impact: {
      before,
      highConfidenceDeduped,
      delta: {
        storedReceiptCount:
          highConfidenceDeduped.storedReceiptCount - before.storedReceiptCount,
        v1SupportedReceiptCount:
          highConfidenceDeduped.v1SupportedReceiptCount -
          before.v1SupportedReceiptCount,
        supportedSpend:
          highConfidenceDeduped.supportedSpend - before.supportedSpend,
        merchantVisitCount:
          highConfidenceDeduped.merchantVisitCount - before.merchantVisitCount,
        itemOccurrenceCount:
          highConfidenceDeduped.itemOccurrenceCount -
          before.itemOccurrenceCount,
        frequentProductCount:
          highConfidenceDeduped.frequentProductCount -
          before.frequentProductCount,
        priceHistoryObservationCount:
          highConfidenceDeduped.priceHistoryObservationCount -
          before.priceHistoryObservationCount,
        trend7dSampleSize:
          highConfidenceDeduped.trend7dSampleSize - before.trend7dSampleSize,
        trend30dSampleSize:
          highConfidenceDeduped.trend30dSampleSize - before.trend30dSampleSize,
        categoryCompositionTotal:
          highConfidenceDeduped.categoryCompositionTotal -
          before.categoryCompositionTotal,
      },
    },
    policyNotes: [
      'OPTION A: count every stored receipt (legacy production behavior).',
      'OPTION B (V1): B_EXCLUDE_CONTENT_AND_STRUCTURAL_EXACT — exclude CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED_STRUCTURAL_EXACT + SEMANTIC_RESCAN_EXACT extras.',
      'OPTION C: also exclude PROBABLE — NOT recommended; PROBABLE is empty/weaker and not used for V1 exclusion.',
      'Category conservation gap is independent of duplicate scans and remains a D2-B topic.',
      'Future metadata (derived only): receipt_fingerprint, duplicate_of_candidate, duplicate_confidence — recompute; no destructive migration.',
      'Future KEEP_SEPARATE override via keepSeparateReceiptIds — no save UI in D2-A3.',
    ],
  };
}

/** Format duplicate audit lines for diagnostics UI (read-only). */
export function formatAnalysisDDuplicateAuditSummary(
  audit: AnalysisDDuplicateScanAudit
): string[] {
  return [
    `stored receipts: ${audit.storedReceiptCount}`,
    `analytics purchase candidates: ${audit.analyticsPurchaseCandidateCount}`,
    `content-exact duplicate extras: ${audit.contentExactDuplicateExtras}`,
    `structural-exact duplicate extras: ${audit.structuralExactDuplicateExtras}`,
    `probable duplicate extras (not excluded): ${audit.probableDuplicateExtras}`,
    `high-confidence duplicate extras: ${audit.highConfidenceDuplicateExtras}`,
    `duplicate groups: ${audit.duplicateGroupCount}`,
    `missing transaction_at: ${audit.missingTransactionAtReceiptCount}`,
    `recommended policy: ${audit.recommendedV1AnalyticsPolicy}`,
    `exclude high-confidence from V1 analytics?: ${
      audit.recommendedExcludeHighConfidenceDuplicatesFromV1Analytics
        ? 'YES'
        : 'NO'
    }`,
    `spend before→highConfidenceDeduped: ${audit.impact.before.supportedSpend} → ${audit.impact.highConfidenceDeduped.supportedSpend}`,
    `visits before→highConfidenceDeduped: ${audit.impact.before.merchantVisitCount} → ${audit.impact.highConfidenceDeduped.merchantVisitCount}`,
    `item occurrences before→highConfidenceDeduped: ${audit.impact.before.itemOccurrenceCount} → ${audit.impact.highConfidenceDeduped.itemOccurrenceCount}`,
    `price obs before→highConfidenceDeduped: ${audit.impact.before.priceHistoryObservationCount} → ${audit.impact.highConfidenceDeduped.priceHistoryObservationCount}`,
    `category composition before→highConfidenceDeduped: ${audit.impact.before.categoryCompositionTotal} → ${audit.impact.highConfidenceDeduped.categoryCompositionTotal}`,
    `category conservation gap (before): ${audit.impact.before.categoryConservationGap}`,
    `sweet-potato storedReceiptCount: ${audit.sweetPotatoAudit.storedReceiptCount}`,
    `sweet-potato purchaseCandidateCount: ${audit.sweetPotatoAudit.purchaseCandidateCount}`,
    `sweet-potato scope: ${audit.sweetPotatoAudit.scopeNote}`,
    ...audit.knownStructuralDuplicateCases.map(
      (c) =>
        `knownStructural ${c.id}: storedScans=${c.storedScanCount} candidates=${c.structuralPurchaseCandidateCount} total=${c.total} at=${c.transactionAtLabel}`
    ),
  ];
}
