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
 *   PROBABLE_DUPLICATE — weaker than structural (V1: empty; not excluded)
 *   NOT_ENOUGH_EVIDENCE — insufficient for high-confidence dedupe
 *
 * Grouping: by STRUCTURAL fingerprint first. If every member shares the same
 * content fingerprint → CONTENT_EXACT_DUPLICATE; else STRUCTURAL_EXACT_DUPLICATE.
 * Multiple content-exact subgroups under one structural fingerprint collapse
 * to ONE group with ONE analytics representative. Reconciled pairs then union
 * across different structural fingerprints when all required evidence holds.
 *
 * Representative rule (documented):
 *   CONTENT/STRUCTURAL groups: earliest created_at, then receipt id ascending.
 *   RECONCILED groups: smallest abs(merchandiseSum-total), then stronger
 *   structural support, then earlier created_at, then receipt id ascending.
 *   Does not merge receipt contents — only chooses which stored receipt
 *   contributes to analytics.
 *
 * V1 policy: B_EXCLUDE_CONTENT_AND_STRUCTURAL_EXACT
 *   Exclude CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED_STRUCTURAL_EXACT extras.
 *   Do NOT exclude PROBABLE / NOT_ENOUGH_EVIDENCE.
 *
 * Collision / safety notes:
 *   - Same merchant + calendar day + total is NOT sufficient.
 *   - Same merchant + total + items with different transaction_at → distinct.
 *   - Missing/invalid transaction_at → never high-confidence dedupe.
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

export const ANALYSIS_D_DUPLICATE_AUDIT_VERSION =
  'meruno-analysis-d-duplicate-audit-v3' as const;

export type AnalysisDDuplicateConfidence =
  | 'CONTENT_EXACT_DUPLICATE'
  | 'STRUCTURAL_EXACT_DUPLICATE'
  | 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
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
  /** Sum of orderedQtyAmountVector line amounts. */
  merchandiseSum: number;
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
  reconciledEvidence?: AnalysisDReconciledStructuralEvidence;
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
  probableDuplicateExtras: number;
  /** CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED_STRUCTURAL_EXACT extras. */
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
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(t));
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
    const second = parts.find((p) => p.type === 'second')?.value ?? '';
    if (hour === '00' && minute === '00' && second === '00') {
      return false;
    }
  } catch {
    return true;
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

function roundMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return (Math.round(n * 100) / 100).toFixed(2);
}

function taxSlot(receipt: ReceiptRow): { known: boolean; value: number | null } {
  const known = receipt.tax_is_known === 1;
  if (!known) return { known: false, value: null };
  const tax = Number(receipt.tax);
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
  if (!hasExactTransactionTime(receipt)) return null;
  const merchant = merchantAnalyticsKey(receipt);
  const tax = taxSlot(receipt);
  const items = extractDuplicateItemEvidence(receipt);
  const itemPart = items
    .map((it) => `${it.quantity}\u001f${roundMoney(it.lineAmount)}`)
    .join('\u001e');
  return [
    'struct-v1',
    merchant,
    String(receipt.transaction_at),
    roundMoney(Number(receipt.total) || 0),
    tax.known ? `tax:${roundMoney(tax.value ?? 0)}` : 'tax:unknown',
    `n:${items.length}`,
    `amt:${itemPart}`,
  ].join('|');
}

export function summarizeReceiptForDuplicateAudit(
  receipt: ReceiptRow
): AnalysisDDuplicateReceiptSummary {
  const items = extractDuplicateItemEvidence(receipt);
  const tax = taxSlot(receipt);
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
    total: Number(receipt.total) || 0,
    tax: tax.value,
    taxKnown: tax.known,
    itemCount: items.length,
    createdAt: receipt.created_at,
    contentFingerprint,
    exactFingerprint: contentFingerprint,
    structuralFingerprint: buildStructuralReceiptFingerprint(receipt),
    orderedQtyAmountVector,
    merchandiseSum,
  };
}

/**
 * Deterministic representative: earliest created_at, then receipt id ASC.
 * Documented rule — do not merge contents; pick analytics contributor only.
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
  if (!a.hasValidTransactionAt || !b.hasValidTransactionAt) return null;
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
  members: AnalysisDDuplicateReceiptSummary[]
): string {
  return pickDuplicateRepresentative(members);
}

function groupByKey<T>(
  rows: T[],
  keyFn: (row: T) => string | null
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

/**
 * High-confidence groups keyed by STRUCTURAL fingerprint.
 * Content-identical clusters → CONTENT_EXACT_DUPLICATE;
 * mixed content under same structure → STRUCTURAL_EXACT_DUPLICATE.
 */
export function buildHighConfidenceDuplicateGroups(
  summaries: AnalysisDDuplicateReceiptSummary[]
): AnalysisDDuplicateGroup[] {
  const structuralGroups: AnalysisDDuplicateGroup[] = [];
  for (const [fp, members] of groupByKey(
    summaries,
    (s) => s.structuralFingerprint
  )) {
    if (members.length < 2) continue;
    const contentKeys = new Set(
      members.map((m) => m.contentFingerprint).filter(Boolean)
    );
    const allSameContent =
      contentKeys.size === 1 &&
      members.every((m) => m.contentFingerprint != null);
    const confidence: AnalysisDDuplicateConfidence = allSameContent
      ? 'CONTENT_EXACT_DUPLICATE'
      : 'STRUCTURAL_EXACT_DUPLICATE';
    const representativeReceiptId = pickRepresentative(members);
    const rep = members.find((m) => m.receiptId === representativeReceiptId)!;
    const matchingEvidence = allSameContent
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
    const differenceEvidence = allSameContent
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
    structuralGroups.push({
      confidence,
      fingerprint: fp,
      receiptIds: members.map((m) => m.receiptId),
      representativeReceiptId,
      merchant: members[0]!.merchantLabel,
      transactionAt: members[0]!.transactionAt,
      total: members[0]!.total,
      itemCount: members[0]!.itemCount,
      matchingEvidence,
      differenceEvidence,
      members,
    });
  }

  const byId = new Map(summaries.map((s) => [s.receiptId, s]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p !== id) {
      const root = find(p);
      parent.set(id, root);
      return root;
    }
    return id;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const s of summaries) parent.set(s.receiptId, s.receiptId);
  for (const g of structuralGroups) {
    for (let i = 1; i < g.receiptIds.length; i++) {
      union(g.receiptIds[0]!, g.receiptIds[i]!);
    }
  }

  type ReconciledLink = NonNullable<
    ReturnType<typeof evaluateReconciledStructuralExactPair>
  >;
  const reconciledLinks: ReconciledLink[] = [];
  for (let i = 0; i < summaries.length; i++) {
    for (let j = i + 1; j < summaries.length; j++) {
      const left = summaries[i]!;
      const right = summaries[j]!;
      if (
        left.structuralFingerprint &&
        left.structuralFingerprint === right.structuralFingerprint
      ) {
        continue;
      }
      const link = evaluateReconciledStructuralExactPair(left, right);
      if (!link) continue;
      reconciledLinks.push(link);
      union(left.receiptId, right.receiptId);
    }
  }

  if (reconciledLinks.length === 0) {
    return structuralGroups;
  }

  const components = new Map<string, AnalysisDDuplicateReceiptSummary[]>();
  for (const s of summaries) {
    const root = find(s.receiptId);
    const list = components.get(root) ?? [];
    list.push(s);
    components.set(root, list);
  }

  const structuralByRoot = new Map<string, AnalysisDDuplicateGroup>();
  for (const g of structuralGroups) {
    structuralByRoot.set(find(g.receiptIds[0]!), g);
  }

  const reconciledTouchedRoots = new Set<string>();
  for (const link of reconciledLinks) {
    reconciledTouchedRoots.add(find(link.core.receiptId));
  }

  const out: AnalysisDDuplicateGroup[] = [];
  const emittedRoots = new Set<string>();

  for (const [root, members] of components) {
    if (members.length < 2) continue;
    if (emittedRoots.has(root)) continue;
    emittedRoots.add(root);

    if (!reconciledTouchedRoots.has(root)) {
      const existing = structuralByRoot.get(root);
      if (existing) out.push(existing);
      continue;
    }

    const links = reconciledLinks.filter(
      (l) => find(l.core.receiptId) === root
    );
    const representativeReceiptId = pickReconciledDuplicateRepresentative(members);
    const rep = members.find((m) => m.receiptId === representativeReceiptId)!;
    const core = links[0]?.core ?? rep;
    const noisyMembers = members.filter(
      (m) => m.receiptId !== core.receiptId && m.itemCount > core.itemCount
    );
    const primaryNoisy = links[0]?.noisy ?? noisyMembers[0] ?? rep;
    const trailingExtraCount = links[0]?.trailingExtraCount ?? 0;
    const trailingExtraAmount = links[0]?.trailingExtraAmount ?? 0;
    const taxDelta = links[0]?.taxDelta ?? null;

    const fingerprint = [
      'reconciled-struct-v1',
      core.merchantKey,
      String(core.transactionAt),
      roundMoney(core.total),
      `coreN:${core.orderedQtyAmountVector.length}`,
      `coreAmt:${core.orderedQtyAmountVector
        .map((r) => `${r.quantity}\u001f${roundMoney(r.lineAmount)}`)
        .join('\u001e')}`,
    ].join('|');

    const reconciledEvidence: AnalysisDReconciledStructuralEvidence = {
      coreReceiptId: core.receiptId,
      noisyReceiptIds: noisyMembers.map((m) => m.receiptId),
      sharedExactCoreVector: core.orderedQtyAmountVector.map((r) => ({
        quantity: r.quantity,
        lineAmount: r.lineAmount,
      })),
      trailingExtraCount,
      trailingExtraAmount,
      coreMerchandiseSum: core.merchandiseSum,
      noisyMerchandiseSum: primaryNoisy.merchandiseSum,
      total: core.total,
      taxDelta,
      representativeReceiptId,
    };

    out.push({
      confidence: 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE',
      fingerprint,
      receiptIds: members.map((m) => m.receiptId),
      representativeReceiptId,
      merchant: members[0]!.merchantLabel,
      transactionAt: members[0]!.transactionAt,
      total: members[0]!.total,
      itemCount: rep.itemCount,
      matchingEvidence: [
        'reconciled_structural_exact_duplicate',
        'same_merchant_analytics_key',
        'exact_transaction_at',
        'exact_total',
        'exact_ordered_qty_amount_prefix',
        'core_merchandise_sum_equals_total',
        'trailing_extras_explain_overage',
        ...(taxDelta != null && taxDelta > 0
          ? ['tax_delta_equals_overage']
          : []),
      ],
      differenceEvidence: [
        `core_receipt_id=${core.receiptId}`,
        `noisy_receipt_ids=${noisyMembers.map((m) => m.receiptId).join(',')}`,
        `trailing_extra_count=${trailingExtraCount}`,
        `trailing_extra_amount=${roundMoney(trailingExtraAmount)}`,
        `core_merchandise_sum=${roundMoney(core.merchandiseSum)}`,
        `noisy_merchandise_sum=${roundMoney(primaryNoisy.merchandiseSum)}`,
        `total=${roundMoney(core.total)}`,
        `tax_delta=${taxDelta == null ? 'n/a' : roundMoney(taxDelta)}`,
        `representative_receipt_id=${representativeReceiptId}`,
      ],
      members,
      reconciledEvidence,
    });
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
  const highConfidence = buildHighConfidenceDuplicateGroups(matchedSummaries);
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
  const groups = buildHighConfidenceDuplicateGroups(summaries);
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

  const highConfidenceGroups = buildHighConfidenceDuplicateGroups(summaries);
  const probableGroups = buildProbableDuplicateGroups(summaries);

  let contentExactDuplicateExtras = 0;
  let structuralExactDuplicateExtras = 0;
  let reconciledStructuralExactDuplicateExtras = 0;
  for (const g of highConfidenceGroups) {
    const extras = Math.max(0, g.receiptIds.length - 1);
    if (g.confidence === 'CONTENT_EXACT_DUPLICATE') {
      contentExactDuplicateExtras += extras;
    } else if (g.confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE') {
      reconciledStructuralExactDuplicateExtras += extras;
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
    reconciledStructuralExactDuplicateExtras;

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
      'OPTION B (V1): B_EXCLUDE_CONTENT_AND_STRUCTURAL_EXACT — exclude CONTENT_EXACT + STRUCTURAL_EXACT + RECONCILED_STRUCTURAL_EXACT extras.',
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
