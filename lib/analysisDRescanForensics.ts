/**
 * Analysis D2-E1 — local-only known Costco re-scan forensic export.
 *
 * Diagnostic instrumentation only. Does not change duplicate policy,
 * analytics selection, category, SKU, OCR, Data Foundation, or History.
 * Never mutates receipts. No telemetry / Supabase upload.
 */

import {
  ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS,
  auditKnownStructuralCostco9534Case,
  buildContentReceiptFingerprint,
  buildStructuralReceiptFingerprint,
  hasValidTransactionAt,
  summarizeReceiptForDuplicateAudit,
  type AnalysisDDuplicateConfidence,
  type AnalysisDDuplicateGroup,
  type AnalysisDKnownStructuralDuplicateCase,
} from './analysisDDuplicateAudit';
import {
  selectAnalyticsReceipts,
  type AnalyticsReceiptSelection,
} from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import { resolveItemFinalCategory } from './homeMetricsHelpers';
import { merchantAnalyticsKey } from './merchantAnalytics';
import { buildSkuKey, resolveProductIdentity } from './productIdentity';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { getReceiptItems } from './receiptItems';

export const ANALYSIS_D_RESCAN_FORENSICS_VERSION =
  'meruno-analysis-d-rescan-forensics-v1' as const;

const SENSITIVE_STORED_KEYS = new Set([
  'user_id',
  'installation_id',
  'image_uri',
  'ocr_request_id',
  'auth_token',
  'session',
  'access_token',
  'refresh_token',
]);

const DISCOUNT_OR_STRUCTURAL_NAME =
  /値引|値引き|割引|クーポン|coupon|discount|ポイント|税|小計|合計|subtotal|total/i;

export type AnalysisDRescanForensicsItemRow = {
  sourceIndex: number;
  rawOcrOrProductName: string | null;
  normalizedOrDisplayName: string | null;
  quantity: number;
  unitPrice: number | null;
  rawLineAmount: number | null;
  effectiveMerchandiseAmount: number;
  rowClassification:
    | 'merchandise'
    | 'discount_or_coupon'
    | 'structural_or_other'
    | 'unknown';
  categoryRaw: string | null;
  categoryFinal: string | null;
  canonical: string | null;
  family: string | null;
  skuKey: string | null;
  specEvidence: string | null;
  specReliability: string | null;
  rawItemRecord: Record<string, unknown>;
};

export type AnalysisDRescanForensicsReceiptExport = {
  receiptId: string;
  present: true;
  createdAt: number;
  rawMerchantValue: string | null;
  resolvedMerchantAnalyticsKey: string;
  rawTransactionDateTimeEvidence: Record<string, unknown>;
  resolvedTransactionAt: number | null;
  hasValidTransactionAt: boolean;
  total: number;
  subtotal: number | null;
  tax: number | null;
  taxKnown: boolean;
  discountOrUnallocatedDiscountFields: Record<string, unknown>;
  storedItemCount: number;
  derivedMerchandiseItemCount: number;
  contentFingerprint: string | null;
  structuralFingerprint: string | null;
  selectedAsProductionAnalyticsRepresentative: boolean;
  excludedAsDuplicate: boolean;
  duplicateConfidence: AnalysisDDuplicateConfidence | null;
  duplicateGroupFingerprint: string | null;
  duplicateGroupRepresentativeReceiptId: string | null;
  items: AnalysisDRescanForensicsItemRow[];
  storedReceiptJson: Record<string, unknown>;
  derivedComparison: {
    orderedQuantityVector: number[];
    orderedAmountVector: number[];
    sumEffectiveMerchandiseAmount: number;
  };
};

export type AnalysisDRescanForensicsMissingTarget = {
  receiptId: string;
  present: false;
  reason: 'not_found_in_local_receipts';
};

export type AnalysisDRescanForensicsPairComparison = {
  leftReceiptId: string;
  rightReceiptId: string;
  merchantKeyEqual: boolean;
  transactionAtEqual: boolean;
  totalEqual: boolean;
  taxSlotEqual: boolean;
  itemCountEqual: boolean;
  orderedQuantityVectorEqual: boolean;
  orderedAmountVectorEqual: boolean;
  sumEffectiveMerchandiseAmountEqual: boolean;
  contentFingerprintEqual: boolean;
  structuralFingerprintEqual: boolean;
};

export type AnalysisDRescanForensicsLineDiff = {
  sourceIndex: number;
  left: AnalysisDRescanForensicsItemRow | null;
  right: AnalysisDRescanForensicsItemRow | null;
  differences: string[];
};

export type AnalysisDRescanForensicsExport = {
  forensicsVersion: typeof ANALYSIS_D_RESCAN_FORENSICS_VERSION;
  generatedAtMs: number;
  purpose: 'known_costco_9534_rescan_ground_truth';
  targetReceiptIds: string[];
  knownStructuralCase: AnalysisDKnownStructuralDuplicateCase | null;
  missingTargetReceiptIds: string[];
  receipts: Array<
    AnalysisDRescanForensicsReceiptExport | AnalysisDRescanForensicsMissingTarget
  >;
  pairwiseComparisons: AnalysisDRescanForensicsPairComparison[];
  caMaVsNehgLineByLine: {
    leftReceiptId: 'C_aMA69ijcqNLhGI76Y5Q';
    rightReceiptId: 'NEHGZCkqd8MiBCyKO-fWd';
    leftPresent: boolean;
    rightPresent: boolean;
    lineDiffs: AnalysisDRescanForensicsLineDiff[];
  };
  notes: string[];
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function readString(
  item: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(
  item: Record<string, unknown>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = Number(item[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function classifyRow(
  name: string | null,
  amount: number
): AnalysisDRescanForensicsItemRow['rowClassification'] {
  if (name && DISCOUNT_OR_STRUCTURAL_NAME.test(name)) {
    if (/値引|値引き|割引|クーポン|coupon|discount/i.test(name)) {
      return 'discount_or_coupon';
    }
    return 'structural_or_other';
  }
  if (amount > 0) return 'merchandise';
  if (amount < 0) return 'discount_or_coupon';
  return 'unknown';
}

function sanitizeStoredReceipt(receipt: ReceiptRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    receipt as unknown as Record<string, unknown>
  )) {
    if (SENSITIVE_STORED_KEYS.has(key)) {
      out[key] = value == null || value === '' ? value : '[redacted]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

function parseAnalysisObject(
  receipt: ReceiptRow
): Record<string, unknown> | null {
  const raw = receipt.analysis_json;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectDiscountFields(
  receipt: ReceiptRow,
  analysis: Record<string, unknown> | null
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const receiptRec = receipt as unknown as Record<string, unknown>;
  for (const key of [
    'discount_total',
    'unallocated_discount',
    'unallocatedDiscount',
    'receipt_discount',
    'discounts',
  ]) {
    if (receiptRec[key] !== undefined) fields[`receipt.${key}`] = receiptRec[key];
    if (analysis && analysis[key] !== undefined) {
      fields[`analysis.${key}`] = analysis[key];
    }
  }
  return fields;
}

function buildItemRows(receipt: ReceiptRow): AnalysisDRescanForensicsItemRow[] {
  const merchantName =
    receipt.merchant_normalized || receipt.merchant_raw || null;
  return getReceiptItems(receipt).map((raw, sourceIndex) => {
    const item = asRecord(raw);
    const rawOcrOrProductName = readString(item, [
      'raw_name',
      'ocr_name',
      'name',
      'product_name',
    ]);
    const normalizedOrDisplayName = readString(item, [
      'normalized_full_name',
      'normalized_name',
      'display_name',
      'name',
    ]);
    const quantityRaw = Number(item.quantity);
    const quantity =
      Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;
    const unitPrice = readNumber(item, ['unit_price', 'unitPrice', 'price']);
    const rawLineAmount = readNumber(item, [
      'lineTotal',
      'line_total',
      'amount',
      'total',
    ]);
    const effectiveMerchandiseAmount = itemAmountForAnalytics(item as never);
    const categoryRaw = readString(item, [
      'category',
      'categoryKey',
      'category_raw',
    ]);
    const categoryFinal = resolveItemFinalCategory(item as never);
    const identity = resolveProductIdentity({
      rawName: rawOcrOrProductName ?? normalizedOrDisplayName ?? '',
      category: categoryRaw,
      merchantName,
      canonicalProductNameEvidence: readString(item, [
        'canonical_product_name',
        'canonicalProductName',
      ]),
      brandEvidence: readString(item, ['brand']),
    });
    const skuKey =
      readString(item, ['sku_key', 'skuKey']) ?? buildSkuKey(identity);
    const spec = identity.specification;
    return {
      sourceIndex,
      rawOcrOrProductName,
      normalizedOrDisplayName,
      quantity,
      unitPrice,
      rawLineAmount,
      effectiveMerchandiseAmount,
      rowClassification: classifyRow(
        rawOcrOrProductName ?? normalizedOrDisplayName,
        effectiveMerchandiseAmount
      ),
      categoryRaw,
      categoryFinal,
      canonical: identity.canonicalProductName,
      family: identity.productFamilyKey,
      skuKey,
      specEvidence: spec.sourceText ?? spec.rawText ?? null,
      specReliability: spec.reliability ?? null,
      rawItemRecord: item,
    };
  });
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

function exportOneReceipt(
  receipt: ReceiptRow,
  selection: AnalyticsReceiptSelection
): AnalysisDRescanForensicsReceiptExport {
  const analysis = parseAnalysisObject(receipt);
  const items = buildItemRows(receipt);
  const summary = summarizeReceiptForDuplicateAudit(receipt);
  const membership = findDuplicateMembership(
    receipt.id,
    selection.highConfidenceDuplicateGroups
  );
  const orderedQuantityVector = items.map((item) => item.quantity);
  const orderedAmountVector = items.map(
    (item) => item.effectiveMerchandiseAmount
  );
  const sumEffectiveMerchandiseAmount = orderedAmountVector.reduce(
    (sum, n) => sum + n,
    0
  );
  const derivedMerchandiseItemCount = items.filter(
    (item) => item.rowClassification === 'merchandise'
  ).length;

  return {
    receiptId: receipt.id,
    present: true,
    createdAt: receipt.created_at,
    rawMerchantValue: receipt.merchant_raw,
    resolvedMerchantAnalyticsKey: merchantAnalyticsKey(receipt),
    rawTransactionDateTimeEvidence: {
      transaction_at: receipt.transaction_at,
      analysis_transactionDate: analysis?.transactionDate ?? null,
      analysis_transactionAt: analysis?.transactionAt ?? null,
      analysis_purchasedAt: analysis?.purchasedAt ?? null,
      analysis_datetime: analysis?.datetime ?? null,
    },
    resolvedTransactionAt: hasValidTransactionAt(receipt)
      ? receipt.transaction_at
      : null,
    hasValidTransactionAt: hasValidTransactionAt(receipt),
    total: Number(receipt.total) || 0,
    subtotal:
      readNumber(asRecord(receipt), ['subtotal']) ??
      readNumber(analysis ?? {}, ['subtotal', 'sub_total']) ??
      null,
    tax: summary.tax,
    taxKnown: summary.taxKnown,
    discountOrUnallocatedDiscountFields: collectDiscountFields(
      receipt,
      analysis
    ),
    storedItemCount: items.length,
    derivedMerchandiseItemCount,
    contentFingerprint:
      summary.contentFingerprint ?? buildContentReceiptFingerprint(receipt),
    structuralFingerprint:
      summary.structuralFingerprint ??
      buildStructuralReceiptFingerprint(receipt),
    selectedAsProductionAnalyticsRepresentative: selection.analyticsReceipts.some(
      (r) => r.id === receipt.id
    ),
    excludedAsDuplicate: selection.excludedDuplicateReceiptIds.has(receipt.id),
    duplicateConfidence: membership.confidence,
    duplicateGroupFingerprint: membership.fingerprint,
    duplicateGroupRepresentativeReceiptId: membership.representativeReceiptId,
    items,
    storedReceiptJson: sanitizeStoredReceipt(receipt),
    derivedComparison: {
      orderedQuantityVector,
      orderedAmountVector,
      sumEffectiveMerchandiseAmount,
    },
  };
}

function vectorsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i]! - b[i]!) > 0.009) return false;
  }
  return true;
}

function comparePair(
  left: AnalysisDRescanForensicsReceiptExport,
  right: AnalysisDRescanForensicsReceiptExport
): AnalysisDRescanForensicsPairComparison {
  const taxSlotEqual =
    left.taxKnown === right.taxKnown &&
    ((left.tax == null && right.tax == null) ||
      (left.tax != null &&
        right.tax != null &&
        Math.abs(left.tax - right.tax) < 0.009));
  return {
    leftReceiptId: left.receiptId,
    rightReceiptId: right.receiptId,
    merchantKeyEqual:
      left.resolvedMerchantAnalyticsKey === right.resolvedMerchantAnalyticsKey,
    transactionAtEqual:
      left.resolvedTransactionAt === right.resolvedTransactionAt,
    totalEqual: Math.abs(left.total - right.total) < 0.009,
    taxSlotEqual,
    itemCountEqual: left.storedItemCount === right.storedItemCount,
    orderedQuantityVectorEqual: vectorsEqual(
      left.derivedComparison.orderedQuantityVector,
      right.derivedComparison.orderedQuantityVector
    ),
    orderedAmountVectorEqual: vectorsEqual(
      left.derivedComparison.orderedAmountVector,
      right.derivedComparison.orderedAmountVector
    ),
    sumEffectiveMerchandiseAmountEqual:
      Math.abs(
        left.derivedComparison.sumEffectiveMerchandiseAmount -
          right.derivedComparison.sumEffectiveMerchandiseAmount
      ) < 0.009,
    contentFingerprintEqual:
      left.contentFingerprint != null &&
      left.contentFingerprint === right.contentFingerprint,
    structuralFingerprintEqual:
      left.structuralFingerprint != null &&
      left.structuralFingerprint === right.structuralFingerprint,
  };
}

function lineByLineDiff(
  left: AnalysisDRescanForensicsReceiptExport | null,
  right: AnalysisDRescanForensicsReceiptExport | null
): AnalysisDRescanForensicsLineDiff[] {
  const leftItems = left?.items ?? [];
  const rightItems = right?.items ?? [];
  const max = Math.max(leftItems.length, rightItems.length);
  const diffs: AnalysisDRescanForensicsLineDiff[] = [];
  for (let i = 0; i < max; i += 1) {
    const l = leftItems[i] ?? null;
    const r = rightItems[i] ?? null;
    const differences: string[] = [];
    if (!l && r) differences.push('only_on_right');
    if (l && !r) differences.push('only_on_left');
    if (l && r) {
      if (l.rawOcrOrProductName !== r.rawOcrOrProductName) {
        differences.push('rawOcrOrProductName');
      }
      if (l.quantity !== r.quantity) differences.push('quantity');
      if (
        Math.abs(
          l.effectiveMerchandiseAmount - r.effectiveMerchandiseAmount
        ) > 0.009
      ) {
        differences.push('effectiveMerchandiseAmount');
      }
      if (l.rowClassification !== r.rowClassification) {
        differences.push('rowClassification');
      }
    }
    if (differences.length > 0) {
      diffs.push({ sourceIndex: i, left: l, right: r, differences });
    }
  }
  return diffs;
}

/**
 * Pure builder: local receipts → forensic JSON for the known Costco case.
 * Does not write files, upload, or mutate caller-owned receipt objects.
 */
export function buildAnalysisDRescanForensicsExport(args: {
  receipts: ReceiptRow[];
  nowMs?: number;
  targetReceiptIds?: readonly string[];
}): AnalysisDRescanForensicsExport {
  const nowMs = args.nowMs ?? Date.now();
  const targetReceiptIds = [
    ...(args.targetReceiptIds ??
      ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS),
  ];
  const receipts = args.receipts.map((r) => ({ ...r }));
  const byId = new Map(receipts.map((r) => [r.id, r]));
  const selection = selectAnalyticsReceipts(receipts);
  const knownStructuralCase = auditKnownStructuralCostco9534Case(receipts);

  const exported: Array<
    AnalysisDRescanForensicsReceiptExport | AnalysisDRescanForensicsMissingTarget
  > = [];
  const missingTargetReceiptIds: string[] = [];
  const presentExports: AnalysisDRescanForensicsReceiptExport[] = [];

  for (const id of targetReceiptIds) {
    const row = byId.get(id);
    if (!row) {
      missingTargetReceiptIds.push(id);
      exported.push({
        receiptId: id,
        present: false,
        reason: 'not_found_in_local_receipts',
      });
      continue;
    }
    const one = exportOneReceipt(row, selection);
    exported.push(one);
    presentExports.push(one);
  }

  const pairwiseComparisons: AnalysisDRescanForensicsPairComparison[] = [];
  for (let i = 0; i < presentExports.length; i += 1) {
    for (let j = i + 1; j < presentExports.length; j += 1) {
      pairwiseComparisons.push(
        comparePair(presentExports[i]!, presentExports[j]!)
      );
    }
  }

  const caMa =
    presentExports.find((r) => r.receiptId === 'C_aMA69ijcqNLhGI76Y5Q') ?? null;
  const nehg =
    presentExports.find((r) => r.receiptId === 'NEHGZCkqd8MiBCyKO-fWd') ?? null;

  return {
    forensicsVersion: ANALYSIS_D_RESCAN_FORENSICS_VERSION,
    generatedAtMs: nowMs,
    purpose: 'known_costco_9534_rescan_ground_truth',
    targetReceiptIds,
    knownStructuralCase,
    missingTargetReceiptIds,
    receipts: exported,
    pairwiseComparisons,
    caMaVsNehgLineByLine: {
      leftReceiptId: 'C_aMA69ijcqNLhGI76Y5Q',
      rightReceiptId: 'NEHGZCkqd8MiBCyKO-fWd',
      leftPresent: caMa != null,
      rightPresent: nehg != null,
      lineDiffs: lineByLineDiff(caMa, nehg),
    },
    notes: [
      'Local diagnostics only — no telemetry / Supabase upload.',
      'Uses getReceiptItems() source order; no fuzzy string matching.',
      'Does not change selectAnalyticsReceipts / duplicate fingerprints / production analytics.',
      'storedReceiptJson redacts image_uri / user_id / installation_id / ocr_request_id.',
    ],
  };
}

export function serializeAnalysisDRescanForensicsExport(
  payload: AnalysisDRescanForensicsExport
): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
