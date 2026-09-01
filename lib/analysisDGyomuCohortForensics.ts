/**
 * Analysis D2-E2 — Gyomu ¥3,393 full-cohort forensic export.
 *
 * Diagnostic instrumentation only. Queries local receipts by merchant analytics
 * key + exact transaction_at + exact total. Does not change duplicate policy,
 * analytics selection, schema, or stored receipts.
 */

import {
  areStructuralExactDuplicateSummaries,
  buildContentReceiptFingerprint,
  buildStructuralReceiptFingerprint,
  normalizeStructuralDuplicateCurrency,
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateConfidence,
  type AnalysisDDuplicateGroup,
  type AnalysisDDuplicateReceiptSummary,
  type AnalysisDQtyAmountRow,
} from './analysisDDuplicateAudit';
import {
  selectAnalyticsReceipts,
  type AnalyticsReceiptSelection,
} from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import { merchantAnalyticsKey } from './merchantAnalytics';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { getReceiptItems } from './receiptItems';

export const ANALYSIS_D_GYOMU_COHORT_FORENSICS_VERSION =
  'meruno-analysis-d-gyomu-cohort-forensics-v1' as const;

/** Build 81 Gyomu physical-purchase cohort anchor (device ground truth). */
export const ANALYSIS_D_GYOMU_3393_COHORT_TARGET = {
  merchantAnalyticsKey: '業務スーパー古川',
  transactionAt: 1786351380000,
  total: 3393,
  expectedStoredRowCount: 7,
} as const;

/** Known 6-member duplicate group from Build 81 device audit (reference only). */
export const ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS = [
  'ACsMESsCvPCD9Vsgpmn4V',
  'erhG0uXoyTm6vRFNCrBFe',
  'KzeeGp7HDiUxMu0D0CyzE',
  'lmg2SfKrcRGFCM1JVpOMS',
  'rbVx_AFdAfnwFywe11mR_',
  'sLOTqc_9eqHnMhJLlzQpx',
] as const;

export type AnalysisDGyomuCohortForensicsItemRow = {
  name: string | null;
  quantity: number | null;
  lineTotal: number | null;
  effectiveLineTotal: number;
};

export type AnalysisDGyomuCohortForensicsReceiptExport = {
  receiptId: string;
  createdAt: number;
  rawMerchant: string | null;
  resolvedMerchantAnalyticsKey: string;
  transactionAt: number | null;
  total: number;
  currency: string | null;
  tax: number | null;
  taxIsKnown: boolean;
  itemCount: number;
  rawItemRows: AnalysisDGyomuCohortForensicsItemRow[];
  orderedQtyAmountVector: AnalysisDQtyAmountRow[];
  canonicalStructuralBasket: AnalysisDQtyAmountRow[];
  merchandiseSum: number;
  structuralDuplicateEligible: boolean;
  structuralFingerprint: string | null;
  contentFingerprint: string | null;
  selectedAsProductionAnalyticsRepresentative: boolean;
  excludedAsDuplicate: boolean;
  duplicateConfidence: AnalysisDDuplicateConfidence | null;
  duplicateGroupRepresentativeReceiptId: string | null;
  duplicateGroupFingerprint: string | null;
  inKnownSixMemberGroup: boolean;
};

export type AnalysisDGyomuCohortForensicsPairComparison = {
  leftReceiptId: string;
  rightReceiptId: string;
  merchantEqual: boolean;
  transactionAtEqual: boolean;
  totalEqual: boolean;
  currencyEqual: boolean;
  taxCompatible: boolean;
  itemCountEqual: boolean;
  canonicalStructuralBasketEqual: boolean;
  structuralMatcherAccepted: boolean;
  structuralMatcherReason: string;
};

export type AnalysisDGyomuCohortForensicsExport = {
  forensicsVersion: typeof ANALYSIS_D_GYOMU_COHORT_FORENSICS_VERSION;
  generatedAtMs: number;
  purpose: 'gyomu_3393_full_cohort_rescan_forensics';
  cohortTarget: typeof ANALYSIS_D_GYOMU_3393_COHORT_TARGET;
  knownSixMemberGroupReceiptIds: readonly string[];
  matchedReceiptIds: string[];
  receiptsOutsideKnownSixMemberGroup: string[];
  receipts: AnalysisDGyomuCohortForensicsReceiptExport[];
  pairwiseComparisons: AnalysisDGyomuCohortForensicsPairComparison[];
  notes: string[];
};

function asItemRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function readItemName(item: Record<string, unknown>): string | null {
  for (const key of [
    'name',
    'raw_name',
    'normalized_full_name',
    'canonical_product_name',
  ]) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readRawLineTotal(item: Record<string, unknown>): number | null {
  const lineTotal = item.lineTotal;
  if (typeof lineTotal === 'number' && Number.isFinite(lineTotal)) return lineTotal;
  const line_total = item.line_total;
  if (typeof line_total === 'number' && Number.isFinite(line_total)) return line_total;
  return null;
}

function readRawQuantity(item: Record<string, unknown>): number | null {
  const quantity = item.quantity;
  if (typeof quantity === 'number' && Number.isFinite(quantity)) return quantity;
  return null;
}

function roundMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return (Math.round(n * 100) / 100).toFixed(2);
}

function moneyEquals(a: number, b: number): boolean {
  return roundMoney(a) === roundMoney(b);
}

function qtyAmountVectorEquals(
  a: readonly AnalysisDQtyAmountRow[],
  b: readonly AnalysisDQtyAmountRow[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.quantity !== right.quantity ||
      !moneyEquals(left.lineAmount, right.lineAmount)
    ) {
      return false;
    }
  }
  return true;
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

/**
 * Read-only mirror of areStructuralExactDuplicateSummaries gate order.
 * Does not mutate matcher state or receipts.
 */
export function explainStructuralExactDuplicatePair(
  left: AnalysisDDuplicateReceiptSummary,
  right: AnalysisDDuplicateReceiptSummary
): { accepted: boolean; reason: string } {
  if (!left.structuralDuplicateEligible || !right.structuralDuplicateEligible) {
    const side = !left.structuralDuplicateEligible
      ? left.receiptId
      : right.receiptId;
    return {
      accepted: false,
      reason: `structuralDuplicateEligible=false (${side})`,
    };
  }
  if (!left.currency || left.currency !== right.currency) {
    return {
      accepted: false,
      reason: `currency_mismatch (${left.currency ?? 'null'} vs ${right.currency ?? 'null'})`,
    };
  }
  if (!left.hasExactTransactionTime || !right.hasExactTransactionTime) {
    return {
      accepted: false,
      reason: 'missing_exact_transaction_time',
    };
  }
  if (!left.merchantKey || left.merchantKey !== right.merchantKey) {
    return {
      accepted: false,
      reason: `merchant_mismatch (${left.merchantKey} vs ${right.merchantKey})`,
    };
  }
  if (left.transactionAt == null || left.transactionAt !== right.transactionAt) {
    return {
      accepted: false,
      reason: `transaction_at_mismatch (${String(left.transactionAt)} vs ${String(right.transactionAt)})`,
    };
  }
  if (
    !Number.isFinite(left.total) ||
    left.total <= 0 ||
    !Number.isFinite(right.total) ||
    right.total <= 0
  ) {
    return { accepted: false, reason: 'invalid_total' };
  }
  if (!moneyEquals(left.total, right.total)) {
    return {
      accepted: false,
      reason: `total_mismatch (${left.total} vs ${right.total})`,
    };
  }
  if (
    left.canonicalStructuralBasket.length === 0 ||
    right.canonicalStructuralBasket.length === 0
  ) {
    return { accepted: false, reason: 'empty_canonical_structural_basket' };
  }
  if (!areStructuralTaxSlotsCompatible(left, right)) {
    return { accepted: false, reason: 'tax_incompatible' };
  }
  if (!qtyAmountVectorEquals(left.canonicalStructuralBasket, right.canonicalStructuralBasket)) {
    return { accepted: false, reason: 'canonical_structural_basket_mismatch' };
  }
  return { accepted: true, reason: 'structural_exact_duplicate_match' };
}

export function receiptMatchesGyomu3393Cohort(
  receipt: ReceiptRow,
  target: typeof ANALYSIS_D_GYOMU_3393_COHORT_TARGET = ANALYSIS_D_GYOMU_3393_COHORT_TARGET
): boolean {
  if (merchantAnalyticsKey(receipt) !== target.merchantAnalyticsKey) return false;
  if (receipt.transaction_at !== target.transactionAt) return false;
  const total = Number(receipt.total);
  if (!Number.isFinite(total)) return false;
  return moneyEquals(total, target.total);
}

function findDuplicateMembership(
  receiptId: string,
  groups: AnalysisDDuplicateGroup[]
): {
  confidence: AnalysisDDuplicateConfidence | null;
  fingerprint: string | null;
  representativeReceiptId: string | null;
} {
  for (const group of groups) {
    if (!group.receiptIds.includes(receiptId)) continue;
    return {
      confidence: group.confidence,
      fingerprint: group.fingerprint,
      representativeReceiptId: group.representativeReceiptId,
    };
  }
  return {
    confidence: null,
    fingerprint: null,
    representativeReceiptId: null,
  };
}

function buildRawItemRows(receipt: ReceiptRow): AnalysisDGyomuCohortForensicsItemRow[] {
  return getReceiptItems(receipt).map((raw) => {
    const item = asItemRecord(raw);
    return {
      name: readItemName(item),
      quantity: readRawQuantity(item),
      lineTotal: readRawLineTotal(item),
      effectiveLineTotal: itemAmountForAnalytics(item as never),
    };
  });
}

function exportOneReceipt(
  receipt: ReceiptRow,
  selection: AnalyticsReceiptSelection,
  summary: AnalysisDDuplicateReceiptSummary
): AnalysisDGyomuCohortForensicsReceiptExport {
  const membership = findDuplicateMembership(
    receipt.id,
    selection.highConfidenceDuplicateGroups
  );
  const rawItemRows = buildRawItemRows(receipt);
  return {
    receiptId: receipt.id,
    createdAt: receipt.created_at,
    rawMerchant: receipt.merchant_raw ?? null,
    resolvedMerchantAnalyticsKey: merchantAnalyticsKey(receipt),
    transactionAt: receipt.transaction_at ?? null,
    total: Number(receipt.total) || 0,
    currency: normalizeStructuralDuplicateCurrency(receipt.currency),
    tax: summary.tax,
    taxIsKnown: summary.taxKnown,
    itemCount: rawItemRows.length,
    rawItemRows,
    orderedQtyAmountVector: summary.orderedQtyAmountVector,
    canonicalStructuralBasket: summary.canonicalStructuralBasket,
    merchandiseSum: summary.merchandiseSum,
    structuralDuplicateEligible: summary.structuralDuplicateEligible,
    structuralFingerprint:
      summary.structuralFingerprint ?? buildStructuralReceiptFingerprint(receipt),
    contentFingerprint:
      summary.contentFingerprint ?? buildContentReceiptFingerprint(receipt),
    selectedAsProductionAnalyticsRepresentative: selection.analyticsReceipts.some(
      (row) => row.id === receipt.id
    ),
    excludedAsDuplicate: selection.excludedDuplicateReceiptIds.has(receipt.id),
    duplicateConfidence: membership.confidence,
    duplicateGroupRepresentativeReceiptId: membership.representativeReceiptId,
    duplicateGroupFingerprint: membership.fingerprint,
    inKnownSixMemberGroup:
      ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS.includes(
        receipt.id as (typeof ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS)[number]
      ),
  };
}

function comparePair(
  left: AnalysisDGyomuCohortForensicsReceiptExport,
  right: AnalysisDGyomuCohortForensicsReceiptExport,
  leftSummary: AnalysisDDuplicateReceiptSummary,
  rightSummary: AnalysisDDuplicateReceiptSummary
): AnalysisDGyomuCohortForensicsPairComparison {
  const explanation = explainStructuralExactDuplicatePair(leftSummary, rightSummary);
  const matcherAccepted = areStructuralExactDuplicateSummaries(
    leftSummary,
    rightSummary
  );
  return {
    leftReceiptId: left.receiptId,
    rightReceiptId: right.receiptId,
    merchantEqual:
      left.resolvedMerchantAnalyticsKey === right.resolvedMerchantAnalyticsKey,
    transactionAtEqual: left.transactionAt === right.transactionAt,
    totalEqual: moneyEquals(left.total, right.total),
    currencyEqual: left.currency != null && left.currency === right.currency,
    taxCompatible: areStructuralTaxSlotsCompatible(leftSummary, rightSummary),
    itemCountEqual: left.itemCount === right.itemCount,
    canonicalStructuralBasketEqual: qtyAmountVectorEquals(
      left.canonicalStructuralBasket,
      right.canonicalStructuralBasket
    ),
    structuralMatcherAccepted: matcherAccepted,
    structuralMatcherReason: explanation.reason,
  };
}

/**
 * Pure builder: local receipts → Gyomu ¥3,393 cohort forensic JSON.
 * Includes every stored row matching merchant + transaction_at + total,
 * not only members of the known six-receipt duplicate group.
 */
export function buildAnalysisDGyomuCohortForensicsExport(args: {
  receipts: ReceiptRow[];
  nowMs?: number;
  cohortTarget?: typeof ANALYSIS_D_GYOMU_3393_COHORT_TARGET;
}): AnalysisDGyomuCohortForensicsExport {
  const nowMs = args.nowMs ?? Date.now();
  const cohortTarget = args.cohortTarget ?? ANALYSIS_D_GYOMU_3393_COHORT_TARGET;
  const receipts = args.receipts.map((row) => ({ ...row }));
  const matched = receipts
    .filter((row) => receiptMatchesGyomu3393Cohort(row, cohortTarget))
    .sort((a, b) => a.id.localeCompare(b.id));
  const selection = selectAnalyticsReceipts(receipts);
  const summaries = new Map(
    matched.map((row) => [row.id, summarizeReceiptForDuplicateAudit(row)])
  );
  const exported = matched.map((row) =>
    exportOneReceipt(row, selection, summaries.get(row.id)!)
  );
  const pairwiseComparisons: AnalysisDGyomuCohortForensicsPairComparison[] = [];
  for (let i = 0; i < exported.length; i += 1) {
    for (let j = i + 1; j < exported.length; j += 1) {
      const left = exported[i]!;
      const right = exported[j]!;
      pairwiseComparisons.push(
        comparePair(
          left,
          right,
          summaries.get(left.receiptId)!,
          summaries.get(right.receiptId)!
        )
      );
    }
  }
  const matchedReceiptIds = matched.map((row) => row.id);
  const knownSet = new Set(
    ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS
  );
  const receiptsOutsideKnownSixMemberGroup = matchedReceiptIds.filter(
    (id) => !knownSet.has(id as (typeof ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS)[number])
  );

  return {
    forensicsVersion: ANALYSIS_D_GYOMU_COHORT_FORENSICS_VERSION,
    generatedAtMs: nowMs,
    purpose: 'gyomu_3393_full_cohort_rescan_forensics',
    cohortTarget,
    knownSixMemberGroupReceiptIds: [
      ...ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS,
    ],
    matchedReceiptIds,
    receiptsOutsideKnownSixMemberGroup,
    receipts: exported,
    pairwiseComparisons,
    notes: [
      'Local diagnostics only — no telemetry / Supabase upload.',
      'Cohort query: merchant analytics key + exact transaction_at + exact total.',
      'Includes receipts outside the known six-member duplicate group when present locally.',
      'structuralMatcherReason mirrors areStructuralExactDuplicateSummaries gate order (read-only).',
      'Does not change selectAnalyticsReceipts / duplicate fingerprints / production analytics.',
    ],
  };
}

export function serializeAnalysisDGyomuCohortForensicsExport(
  payload: AnalysisDGyomuCohortForensicsExport
): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
