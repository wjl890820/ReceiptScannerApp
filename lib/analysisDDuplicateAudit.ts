/**
 * Analysis D2-A — read-only duplicate / re-scan audit.
 *
 * Domain freeze:
 *   Stored Receipt Record ≠ Unique Real-World Purchase
 *
 * Exact fingerprint is deterministic and independent of receipt id / created_at.
 * Probable matching is diagnostic-only (no approximate string matching).
 * Never deletes, merges, or mutates receipts.
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
  'meruno-analysis-d-duplicate-audit-v1' as const;

export type AnalysisDDuplicateConfidence =
  | 'EXACT_DUPLICATE_CANDIDATE'
  | 'PROBABLE_DUPLICATE_CANDIDATE'
  | 'NOT_ENOUGH_EVIDENCE';

export type AnalysisDDuplicateItemEvidence = {
  nameCanonical: string;
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
  exactFingerprint: string | null;
  structuralFingerprint: string | null;
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

export type AnalysisDSweetPotatoAudit = {
  matchedReceiptIds: string[];
  matchedItemLineCount: number;
  interpretation:
    | 'SAME_RECEIPT_SCANNED_TWICE'
    | 'TWO_ITEM_LINES_ON_ONE_RECEIPT'
    | 'TWO_DISTINCT_STORED_RECEIPTS'
    | 'MIXED_OR_UNCLEAR'
    | 'NOT_FOUND';
  notes: string[];
};

export type AnalysisDDuplicateScanAudit = {
  auditVersion: typeof ANALYSIS_D_DUPLICATE_AUDIT_VERSION;
  storedReceiptCount: number;
  exactUniquePurchaseCandidateCount: number;
  exactDuplicateReceiptCount: number;
  probableDuplicateReceiptCount: number;
  exactDuplicateGroupCount: number;
  probableDuplicateGroupCount: number;
  notEnoughEvidencePairCount: number;
  missingTransactionAtReceiptCount: number;
  recommendedV1AnalyticsPolicy:
    | 'A_COUNT_ALL'
    | 'B_EXCLUDE_EXACT_ONLY'
    | 'C_EXCLUDE_EXACT_AND_PROBABLE';
  recommendedExcludeExactDuplicatesFromV1Analytics: boolean;
  collisionRiskNotes: string[];
  sweetPotatoAudit: AnalysisDSweetPotatoAudit;
  groups: AnalysisDDuplicateGroup[];
  impact: {
    before: AnalysisDDuplicateImpactMetrics;
    exactDeduped: AnalysisDDuplicateImpactMetrics;
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
 * Exact receipt fingerprint.
 * Independent of receipt id and created_at.
 * Requires valid transaction_at — otherwise null (conservative).
 */
export function buildExactReceiptFingerprint(
  receipt: ReceiptRow
): string | null {
  if (!hasValidTransactionAt(receipt)) return null;
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
 * Structural fingerprint (merchant/time/total/tax/qty+amount sequence).
 * Diagnostic probable detection only when exact names differ.
 */
export function buildStructuralReceiptFingerprint(
  receipt: ReceiptRow
): string | null {
  if (!hasValidTransactionAt(receipt)) return null;
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
    exactFingerprint: buildExactReceiptFingerprint(receipt),
    structuralFingerprint: buildStructuralReceiptFingerprint(receipt),
  };
}

function pickRepresentative(
  members: AnalysisDDuplicateReceiptSummary[]
): string {
  const sorted = [...members].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.receiptId.localeCompare(b.receiptId);
  });
  return sorted[0]!.receiptId;
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

export function buildExactDuplicateGroups(
  summaries: AnalysisDDuplicateReceiptSummary[]
): AnalysisDDuplicateGroup[] {
  const groups: AnalysisDDuplicateGroup[] = [];
  for (const [fp, members] of groupByKey(
    summaries,
    (s) => s.exactFingerprint
  )) {
    if (members.length < 2) continue;
    const representativeReceiptId = pickRepresentative(members);
    const rep = members.find((m) => m.receiptId === representativeReceiptId)!;
    groups.push({
      confidence: 'EXACT_DUPLICATE_CANDIDATE',
      fingerprint: fp,
      receiptIds: members.map((m) => m.receiptId),
      representativeReceiptId,
      merchant: members[0]!.merchantLabel,
      transactionAt: members[0]!.transactionAt,
      total: members[0]!.total,
      itemCount: members[0]!.itemCount,
      matchingEvidence: [
        'identical_exact_fingerprint',
        'merchant',
        'transaction_at',
        'total',
        'tax_slot',
        'ordered_item_name_qty_amount',
      ],
      differenceEvidence: members
        .filter((m) => m.receiptId !== representativeReceiptId)
        .map(
          (m) =>
            `receipt_id=${m.receiptId};created_at_delta_ms=${
              m.createdAt - rep.createdAt
            }`
        ),
      members,
    });
  }
  return groups;
}

export function buildProbableDuplicateGroups(
  summaries: AnalysisDDuplicateReceiptSummary[],
  exactGroupedIds: Set<string>
): AnalysisDDuplicateGroup[] {
  const candidates = summaries.filter(
    (s) =>
      !!s.structuralFingerprint &&
      !!s.exactFingerprint &&
      !exactGroupedIds.has(s.receiptId)
  );
  const groups: AnalysisDDuplicateGroup[] = [];
  for (const [fp, members] of groupByKey(
    candidates,
    (s) => s.structuralFingerprint
  )) {
    if (members.length < 2) continue;
    const exactKeys = new Set(members.map((m) => m.exactFingerprint));
    if (exactKeys.size < 2) continue;
    const representativeReceiptId = pickRepresentative(members);
    groups.push({
      confidence: 'PROBABLE_DUPLICATE_CANDIDATE',
      fingerprint: fp,
      receiptIds: members.map((m) => m.receiptId),
      representativeReceiptId,
      merchant: members[0]!.merchantLabel,
      transactionAt: members[0]!.transactionAt,
      total: members[0]!.total,
      itemCount: members[0]!.itemCount,
      matchingEvidence: [
        'merchant',
        'transaction_at',
        'total',
        'tax_slot',
        'ordered_qty_amount_structure',
      ],
      differenceEvidence: [
        'item_name_canonical_differs',
        'diagnostic_only_not_for_v1_exclusion',
      ],
      members,
    });
  }
  return groups;
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

export function selectExactDedupedReceipts(
  receipts: ReceiptRow[],
  exactGroups: AnalysisDDuplicateGroup[]
): ReceiptRow[] {
  const drop = new Set<string>();
  for (const g of exactGroups) {
    for (const id of g.receiptIds) {
      if (id !== g.representativeReceiptId) drop.add(id);
    }
  }
  return receipts.filter((r) => !drop.has(r.id));
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
    priceHistoryObservationCount: report.priceCoverage.skuPriceHistoryUsableRows,
    trend7dSampleSize,
    trend30dSampleSize,
    categoryCompositionTotal,
    activeCategoryRowAmountSum,
    categoryConservationGap:
      categoryCompositionTotal - activeCategoryRowAmountSum,
  };
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

  let interpretation: AnalysisDSweetPotatoAudit['interpretation'] = 'NOT_FOUND';
  if (matchedReceiptIds.length === 0) {
    notes.push('No Costco sweet-potato ¥698 lines found in provided receipts.');
  } else if (matchedReceiptIds.length === 1 && matchedItemLineCount >= 2) {
    interpretation = 'TWO_ITEM_LINES_ON_ONE_RECEIPT';
    notes.push(
      'Single stored receipt contains multiple matching item lines — Product Detail can show two observations without a re-scan.'
    );
  } else if (matchedReceiptIds.length >= 2) {
    const summaries = receipts
      .filter((r) => matchedReceiptIds.includes(r.id))
      .map(summarizeReceiptForDuplicateAudit);
    const exact = buildExactDuplicateGroups(summaries);
    if (exact.some((g) => g.receiptIds.length >= 2)) {
      interpretation = 'SAME_RECEIPT_SCANNED_TWICE';
      notes.push(
        'Matched receipts share an exact fingerprint — likely the same physical receipt scanned twice.'
      );
    } else {
      interpretation = 'TWO_DISTINCT_STORED_RECEIPTS';
      notes.push(
        'Multiple stored receipts matched but exact fingerprints differ — treat as distinct unless stronger evidence appears.'
      );
    }
  } else {
    interpretation = 'MIXED_OR_UNCLEAR';
  }

  return {
    matchedReceiptIds,
    matchedItemLineCount,
    interpretation,
    notes,
  };
}

export function buildAnalysisDDuplicateScanAudit(
  receipts: ReceiptRow[],
  nowMs: number = Date.now()
): AnalysisDDuplicateScanAudit {
  const summaries = receipts.map(summarizeReceiptForDuplicateAudit);
  const missingTransactionAtReceiptCount = summaries.filter(
    (s) => !s.hasValidTransactionAt
  ).length;

  const exactGroups = buildExactDuplicateGroups(summaries);
  const exactGroupedIds = new Set(exactGroups.flatMap((g) => g.receiptIds));
  const probableGroups = buildProbableDuplicateGroups(
    summaries,
    exactGroupedIds
  );

  const exactDuplicateReceiptCount = exactGroups.reduce(
    (sum, g) => sum + Math.max(0, g.receiptIds.length - 1),
    0
  );
  const probableDuplicateReceiptCount = probableGroups.reduce(
    (sum, g) => sum + Math.max(0, g.receiptIds.length - 1),
    0
  );

  const exactUniquePurchaseCandidateCount =
    receipts.length - exactDuplicateReceiptCount;
  const notEnoughEvidencePairCount =
    countWeakMerchantDayTotalCollisions(summaries);

  const dedupedReceipts = selectExactDedupedReceipts(receipts, exactGroups);
  const beforeReport = buildAnalysisDReport({ receipts, nowMs });
  const afterReport = buildAnalysisDReport({
    receipts: dedupedReceipts,
    nowMs,
  });
  const before = metricsFromReport(beforeReport, receipts.length);
  const exactDeduped = metricsFromReport(afterReport, dedupedReceipts.length);

  const highPrecisionExact =
    exactGroups.length === 0 ||
    exactGroups.every(
      (g) =>
        g.members.every((m) => m.hasValidTransactionAt) &&
        g.matchingEvidence.includes('identical_exact_fingerprint')
    );

  const recommendedExcludeExactDuplicatesFromV1Analytics = highPrecisionExact;
  const recommendedV1AnalyticsPolicy = highPrecisionExact
    ? 'B_EXCLUDE_EXACT_ONLY'
    : 'A_COUNT_ALL';

  return {
    auditVersion: ANALYSIS_D_DUPLICATE_AUDIT_VERSION,
    storedReceiptCount: receipts.length,
    exactUniquePurchaseCandidateCount,
    exactDuplicateReceiptCount,
    probableDuplicateReceiptCount,
    exactDuplicateGroupCount: exactGroups.length,
    probableDuplicateGroupCount: probableGroups.length,
    notEnoughEvidencePairCount,
    missingTransactionAtReceiptCount,
    recommendedV1AnalyticsPolicy,
    recommendedExcludeExactDuplicatesFromV1Analytics,
    collisionRiskNotes: [
      'Same merchant + same calendar day + same total is NOT sufficient for exact duplicate.',
      'Same merchant + total + items with different transaction_at are treated as distinct purchases.',
      'created_at is ignored by the exact fingerprint (scan time ≠ purchase identity).',
      'Receipts missing valid transaction_at are never exact/probable-deduped.',
      'Probable groups are diagnostic-only and must not drive V1 exclusion (policy C rejected without stronger evidence).',
      `Weak merchant/day/total collision pairs (informational only): ${notEnoughEvidencePairCount}`,
    ],
    sweetPotatoAudit: auditSweetPotatoStyleObservations(receipts),
    groups: [...exactGroups, ...probableGroups],
    impact: {
      before,
      exactDeduped,
      delta: {
        storedReceiptCount:
          exactDeduped.storedReceiptCount - before.storedReceiptCount,
        v1SupportedReceiptCount:
          exactDeduped.v1SupportedReceiptCount - before.v1SupportedReceiptCount,
        supportedSpend: exactDeduped.supportedSpend - before.supportedSpend,
        merchantVisitCount:
          exactDeduped.merchantVisitCount - before.merchantVisitCount,
        itemOccurrenceCount:
          exactDeduped.itemOccurrenceCount - before.itemOccurrenceCount,
        frequentProductCount:
          exactDeduped.frequentProductCount - before.frequentProductCount,
        priceHistoryObservationCount:
          exactDeduped.priceHistoryObservationCount -
          before.priceHistoryObservationCount,
        trend7dSampleSize:
          exactDeduped.trend7dSampleSize - before.trend7dSampleSize,
        trend30dSampleSize:
          exactDeduped.trend30dSampleSize - before.trend30dSampleSize,
        categoryCompositionTotal:
          exactDeduped.categoryCompositionTotal -
          before.categoryCompositionTotal,
      },
    },
    policyNotes: [
      'OPTION A: count every stored receipt (current production behavior).',
      'OPTION B (recommended if exact precision stays high): exclude only EXACT_DUPLICATE_CANDIDATE extras.',
      'OPTION C: exclude probable as well — NOT recommended; OCR name variance lacks proven precision.',
      'Category conservation gap is independent of duplicate scans and remains a D2-B topic.',
      'Future metadata (derived only): receipt_fingerprint, duplicate_of_candidate, duplicate_confidence — recompute; no destructive migration.',
    ],
  };
}

/** Format duplicate audit lines for diagnostics UI (read-only). */
export function formatAnalysisDDuplicateAuditSummary(
  audit: AnalysisDDuplicateScanAudit
): string[] {
  return [
    `stored receipts: ${audit.storedReceiptCount}`,
    `exact unique purchase candidates: ${audit.exactUniquePurchaseCandidateCount}`,
    `exact duplicate receipts (extras): ${audit.exactDuplicateReceiptCount}`,
    `exact groups: ${audit.exactDuplicateGroupCount}`,
    `probable duplicate receipts (diagnostic): ${audit.probableDuplicateReceiptCount}`,
    `probable groups: ${audit.probableDuplicateGroupCount}`,
    `missing transaction_at: ${audit.missingTransactionAtReceiptCount}`,
    `recommended policy: ${audit.recommendedV1AnalyticsPolicy}`,
    `exclude exact from V1 analytics?: ${
      audit.recommendedExcludeExactDuplicatesFromV1Analytics ? 'YES' : 'NO'
    }`,
    `spend before→exactDeduped: ${audit.impact.before.supportedSpend} → ${audit.impact.exactDeduped.supportedSpend}`,
    `visits before→exactDeduped: ${audit.impact.before.merchantVisitCount} → ${audit.impact.exactDeduped.merchantVisitCount}`,
    `item occurrences before→exactDeduped: ${audit.impact.before.itemOccurrenceCount} → ${audit.impact.exactDeduped.itemOccurrenceCount}`,
    `price obs before→exactDeduped: ${audit.impact.before.priceHistoryObservationCount} → ${audit.impact.exactDeduped.priceHistoryObservationCount}`,
    `category composition before→exactDeduped: ${audit.impact.before.categoryCompositionTotal} → ${audit.impact.exactDeduped.categoryCompositionTotal}`,
    `category conservation gap (before): ${audit.impact.before.categoryConservationGap}`,
  ];
}
