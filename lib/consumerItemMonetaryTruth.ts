/**
 * Consumer-facing item monetary trust (Receipt074 Round 5).
 *
 * Three distinct concepts:
 *   A. Raw receipt amount — OCR/persisted evidence (Review surfaces)
 *   B. Trusted product spend — attributable paid amount (Product Detail / History)
 *   C. Comparable product price — PPH shelf-price contract (separate)
 *
 * This module projects B only. Never treat A/B/C as interchangeable.
 *
 * Slice 4B.1: bulk projection prepares receipt-level monetary truth once per
 * receiptId within a single projectTrustedConsumerItemAmounts call.
 */

import type { ReceiptRow } from './db';
import {
  itemAmountForAnalytics,
  ownershipBaseIdentityKey,
  type DiscountableItem,
} from './receiptDiscountAllocation';
import { buildReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/monetaryCoherenceEvidence';
import {
  resolveReceiptMonetarySourceBundle,
  type ReceiptMonetarySourceBundle,
} from './analysisFoundation/monetarySourceBundle';
import {
  isTrustedReceiptCurrency,
  normalizeReceiptCurrency,
} from './receiptCurrency';

export type ConsumerItemMonetaryProjection = {
  /** Trusted attributable product spend, or null when unavailable. */
  amount: number | null;
  trusted: boolean;
  reason: string;
};

/** Shared evidence fields every consumer monetary query must supply. */
export type ConsumerMonetaryEvidenceInput = {
  lineTotal: number | null | undefined;
  analysisJson?: string | null;
  userItemsJson?: string | null;
  receiptId?: string | null;
  receiptTotal?: number | null;
  receiptTax?: number | null;
  receiptTaxIsKnown?: number | null;
  finalTotal?: number | null;
  userEdited?: number | null;
  currency?: string | null;
  /** Required mapping into the coherent merchandise item list. */
  sourceIndex?: number | null;
  /** Optional indexed row identity for correspondence checks. */
  displayName?: string | null;
  rawName?: string | null;
  purchaseQuantity?: number | null;
};

export type ConsumerMonetaryRowFields = {
  receiptId: string;
  lineTotal: number | null;
  sourceIndex?: number | null;
  currency?: string | null;
  displayName?: string | null;
  rawName?: string | null;
  purchaseQuantity?: number | null;
  receiptAnalysisJson?: string | null;
  receiptUserItemsJson?: string | null;
  receiptTotal?: number | null;
  receiptTax?: number | null;
  receiptTaxIsKnown?: number | null;
  receiptFinalTotal?: number | null;
  receiptUserEdited?: number | null;
};

/**
 * SQL select fragment for receipt-level evidence joined into consumer spend rows.
 * Keep Product History / History Search on the same evidence contract.
 * Callers must also select receipt_items.source_index AS sourceIndex.
 */
export const CONSUMER_MONETARY_RECEIPT_SELECT_SQL = `
       receipts.analysis_json AS receiptAnalysisJson,
       receipts.user_items_json AS receiptUserItemsJson,
       receipts.total AS receiptTotal,
       receipts.tax AS receiptTax,
       COALESCE(receipts.tax_is_known, 0) AS receiptTaxIsKnown,
       receipts.final_total AS receiptFinalTotal,
       COALESCE(receipts.user_edited, 0) AS receiptUserEdited,
       receipts.currency AS currency
`.trim();

/** Receipt-level monetary preparation result (independent of sourceIndex). */
export type PreparedConsumerReceiptMonetaryContext =
  | {
      status: 'blocked';
      reason: string;
    }
  | {
      status: 'ready';
      /** Minimal receipt used for bundle/coherence (read-only consumption). */
      receipt: ReceiptRow;
      bundle: ReceiptMonetarySourceBundle;
    };

export type ConsumerMonetaryBulkStats = {
  receiptContextBuildCount: number;
  receiptContextReuseCount: number;
};

let lastBulkStatsForTests: ConsumerMonetaryBulkStats | null = null;

/** Test seam: stats from the most recent projectTrustedConsumerItemAmounts call. */
export function __getLastConsumerMonetaryBulkStatsForTests(): ConsumerMonetaryBulkStats | null {
  return lastBulkStatsForTests;
}

export function __resetLastConsumerMonetaryBulkStatsForTests(): void {
  lastBulkStatsForTests = null;
}

function finiteAmount(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function analysisJsonPresent(
  analysisJson: string | null | undefined
): analysisJson is string {
  return (
    analysisJson != null &&
    typeof analysisJson === 'string' &&
    analysisJson.trim().length > 0
  );
}

function minimalReceiptForBundle(input: ConsumerMonetaryEvidenceInput): ReceiptRow {
  const currency = normalizeReceiptCurrency(input.currency) ?? '';
  return {
    id: String(input.receiptId || 'consumer-monetary'),
    created_at: 0,
    transaction_at: null,
    image_uri: '',
    total: Number(input.receiptTotal) || 0,
    tax: Number(input.receiptTax) || 0,
    tax_is_known: input.receiptTaxIsKnown === 1 ? 1 : 0,
    currency,
    merchant_raw: null,
    merchant_normalized: null,
    merchant_type: null,
    analysis_json: input.analysisJson ?? null,
    user_edited: input.userEdited === 1 ? 1 : 0,
    final_total:
      input.finalTotal != null && Number.isFinite(Number(input.finalTotal))
        ? Number(input.finalTotal)
        : null,
    final_category: null,
    note: null,
    user_items_json: input.userItemsJson ?? null,
  } as ReceiptRow;
}

/**
 * Receipt-level inputs that define prepared monetary context identity.
 * Production JOIN callers attach identical fields per receiptId; conflicting
 * keys force separate preparation (no silent reuse).
 *
 * Slice 4B.1a: structured field equality — never delimiter-concat fingerprints
 * (U+001F inside JSON is ordinary data and must not collapse distinct inputs).
 */
export type ConsumerReceiptMonetaryPreparationKey = {
  analysisJson: string | null | undefined;
  userItemsJson: string | null | undefined;
  receiptTotal: number | null | undefined;
  receiptTax: number | null | undefined;
  receiptTaxIsKnown: number | null | undefined;
  finalTotal: number | null | undefined;
  userEdited: number | null | undefined;
  currency: string | null | undefined;
};

export function buildConsumerReceiptMonetaryPreparationKey(
  input: Pick<
    ConsumerMonetaryEvidenceInput,
    | 'analysisJson'
    | 'userItemsJson'
    | 'receiptTotal'
    | 'receiptTax'
    | 'receiptTaxIsKnown'
    | 'finalTotal'
    | 'userEdited'
    | 'currency'
  >
): ConsumerReceiptMonetaryPreparationKey {
  return {
    analysisJson: input.analysisJson,
    userItemsJson: input.userItemsJson,
    receiptTotal: input.receiptTotal,
    receiptTax: input.receiptTax,
    receiptTaxIsKnown: input.receiptTaxIsKnown,
    finalTotal: input.finalTotal,
    userEdited: input.userEdited,
    currency: input.currency,
  };
}

/** Exact primitive/string/null/undefined equality — no join/stringify/hash. */
export function isSameConsumerReceiptMonetaryPreparationKey(
  a: ConsumerReceiptMonetaryPreparationKey,
  b: ConsumerReceiptMonetaryPreparationKey
): boolean {
  return (
    a.analysisJson === b.analysisJson &&
    a.userItemsJson === b.userItemsJson &&
    a.receiptTotal === b.receiptTotal &&
    a.receiptTax === b.receiptTax &&
    a.receiptTaxIsKnown === b.receiptTaxIsKnown &&
    a.finalTotal === b.finalTotal &&
    a.userEdited === b.userEdited &&
    a.currency === b.currency
  );
}

function validSourceIndex(
  sourceIndex: unknown,
  itemCount: number
): sourceIndex is number {
  return (
    typeof sourceIndex === 'number' &&
    Number.isInteger(sourceIndex) &&
    Number.isFinite(sourceIndex) &&
    sourceIndex >= 0 &&
    sourceIndex < itemCount
  );
}

function indexedRowName(input: ConsumerMonetaryEvidenceInput): string {
  const display =
    typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (display) return display;
  const raw = typeof input.rawName === 'string' ? input.rawName.trim() : '';
  return raw;
}

const RECEIPT_LEVEL_BLOCK_REASONS = new Set([
  'discount_ownership_unresolved',
  'monetary_source_incoherent',
  'monetary_provenance_insufficient',
  'receipt_level_discount_unallocated_for_spend',
  'analysis_json_missing',
  'currency_unknown',
]);

/**
 * Prepare receipt-level monetary truth (bundle + coherence gates).
 * Independent of sourceIndex / item correspondence.
 */
export function prepareConsumerReceiptMonetaryContext(
  input: ConsumerMonetaryEvidenceInput
): PreparedConsumerReceiptMonetaryContext {
  if (!analysisJsonPresent(input.analysisJson)) {
    return { status: 'blocked', reason: 'analysis_json_missing' };
  }

  if (!isTrustedReceiptCurrency(input.currency)) {
    return { status: 'blocked', reason: 'currency_unknown' };
  }

  const receipt = minimalReceiptForBundle(input);
  const bundle = resolveReceiptMonetarySourceBundle(receipt);

  if (bundle.discountOwnershipStatus === 'unresolved') {
    return { status: 'blocked', reason: 'discount_ownership_unresolved' };
  }

  if (!bundle.coherent) {
    return { status: 'blocked', reason: 'monetary_source_incoherent' };
  }

  const coherence = buildReceiptMonetaryCoherenceEvidence(receipt);
  if (!coherence.monetaryProvenanceSufficient) {
    return { status: 'blocked', reason: 'monetary_provenance_insufficient' };
  }

  // ANY nonzero unallocated receipt-level reduction → product spend unknown.
  const remainder = Number(bundle.receiptLevelUnallocatedDiscountTotal);
  if (Number.isFinite(remainder) && remainder !== 0) {
    return {
      status: 'blocked',
      reason: 'receipt_level_discount_unallocated_for_spend',
    };
  }

  return { status: 'ready', receipt, bundle };
}

/**
 * Item-specific projection against an already-prepared receipt context.
 * Authoritative item path shared by single-item and bulk APIs.
 */
export function projectTrustedConsumerItemAmountWithPreparedReceipt(
  input: ConsumerMonetaryEvidenceInput,
  prepared: PreparedConsumerReceiptMonetaryContext
): ConsumerItemMonetaryProjection {
  if (prepared.status === 'blocked') {
    return {
      amount: null,
      trusted: false,
      reason: prepared.reason,
    };
  }

  const { bundle } = prepared;

  if (!validSourceIndex(input.sourceIndex, bundle.items.length)) {
    return {
      amount: null,
      trusted: false,
      reason: 'source_index_invalid',
    };
  }

  const mapped = bundle.items[input.sourceIndex] as DiscountableItem;
  const mappedAmount = itemAmountForAnalytics(mapped);
  if (!Number.isFinite(mappedAmount)) {
    return {
      amount: null,
      trusted: false,
      reason: 'mapped_amount_missing',
    };
  }

  const indexed = finiteAmount(input.lineTotal);
  if (indexed != null && indexed !== mappedAmount) {
    return {
      amount: null,
      trusted: false,
      reason: 'item_correspondence_mismatch',
    };
  }

  const indexedName = indexedRowName(input);
  const mappedName =
    typeof mapped.name === 'string' ? String(mapped.name).trim() : '';
  if (indexedName && mappedName) {
    const indexedCore = ownershipBaseIdentityKey(indexedName);
    const mappedCore = ownershipBaseIdentityKey(mappedName);
    if (indexedCore && mappedCore && indexedCore !== mappedCore) {
      return {
        amount: null,
        trusted: false,
        reason: 'item_correspondence_mismatch',
      };
    }
  }

  const indexedQty = finiteAmount(input.purchaseQuantity);
  const mappedQty = finiteAmount(
    (mapped as { quantity?: unknown }).quantity ??
      (mapped as { purchase_quantity?: unknown }).purchase_quantity
  );
  if (
    indexedQty != null &&
    mappedQty != null &&
    indexedQty > 0 &&
    mappedQty > 0 &&
    indexedQty !== mappedQty
  ) {
    return {
      amount: null,
      trusted: false,
      reason: 'item_correspondence_mismatch',
    };
  }

  return {
    amount: mappedAmount,
    trusted: true,
    reason: 'trusted_product_spend',
  };
}

/**
 * Project whether a receipt_items line may be shown / summed as
 * trusted attributable product spend (concept B).
 *
 * Ordering:
 * 1. Establish receipt/product monetary trust (ownership + provenance + closure)
 * 2. Require valid sourceIndex correspondence to source-of-truth merchandise
 * 3. Project money from THAT mapped item only — never fall back to raw index amount
 */
export function projectTrustedConsumerItemAmount(
  input: ConsumerMonetaryEvidenceInput
): ConsumerItemMonetaryProjection {
  const prepared = prepareConsumerReceiptMonetaryContext(input);
  return projectTrustedConsumerItemAmountWithPreparedReceipt(input, prepared);
}

function toEvidenceInput(row: ConsumerMonetaryRowFields): ConsumerMonetaryEvidenceInput {
  return {
    lineTotal: row.lineTotal,
    analysisJson: row.receiptAnalysisJson,
    userItemsJson: row.receiptUserItemsJson,
    receiptId: row.receiptId,
    receiptTotal: row.receiptTotal,
    receiptTax: row.receiptTax,
    receiptTaxIsKnown: row.receiptTaxIsKnown,
    finalTotal: row.receiptFinalTotal,
    userEdited: row.receiptUserEdited,
    currency: row.currency,
    sourceIndex: row.sourceIndex,
    displayName: row.displayName,
    rawName: row.rawName,
    purchaseQuantity: row.purchaseQuantity,
  };
}

type PreparedCacheEntry = {
  preparationKey: ConsumerReceiptMonetaryPreparationKey;
  prepared: PreparedConsumerReceiptMonetaryContext;
};

/**
 * Apply consumer monetary projection to item rows.
 * Untrusted rows keep occurrence identity but set lineTotal to null.
 *
 * Slice 4B.1 / 4B.1a: receipt-level preparation runs once per receiptId when
 * preparation keys are exactly equal; item correspondence stays per-row.
 */
export function projectTrustedConsumerItemAmounts<
  T extends ConsumerMonetaryRowFields,
>(
  rows: readonly T[]
): Array<T & { monetaryTrusted: boolean; monetaryTrustReason: string }> {
  type ReceiptGate = {
    reason: string;
    receiptSpendAllowed: boolean;
  };
  const gateByReceipt = new Map<string, ReceiptGate>();
  const preparedByReceipt = new Map<string, PreparedCacheEntry>();
  let receiptContextBuildCount = 0;
  let receiptContextReuseCount = 0;

  const resolvePrepared = (
    input: ConsumerMonetaryEvidenceInput,
    receiptId: string
  ): PreparedConsumerReceiptMonetaryContext => {
    const preparationKey = buildConsumerReceiptMonetaryPreparationKey(input);
    const cached = preparedByReceipt.get(receiptId);
    if (
      cached &&
      isSameConsumerReceiptMonetaryPreparationKey(
        cached.preparationKey,
        preparationKey
      )
    ) {
      receiptContextReuseCount += 1;
      return cached.prepared;
    }
    // Conflicting key for same receiptId: prepare without overwriting
    // a prior compatible cache entry (fail closed to separate preparation).
    receiptContextBuildCount += 1;
    const prepared = prepareConsumerReceiptMonetaryContext(input);
    if (!cached) {
      preparedByReceipt.set(receiptId, { preparationKey, prepared });
    }
    return prepared;
  };

  try {
    return rows.map((row) => {
      const input = toEvidenceInput(row);
      let gate = gateByReceipt.get(row.receiptId);
      // First row of a receipt: prepare once, run probe, then project with
      // the same prepared context (avoid a second resolvePrepared).
      let preparedForRow: PreparedConsumerReceiptMonetaryContext | null = null;
      if (!gate) {
        preparedForRow = resolvePrepared(input, row.receiptId);
        const probe = projectTrustedConsumerItemAmountWithPreparedReceipt(
          input,
          preparedForRow
        );
        const receiptBlocked = RECEIPT_LEVEL_BLOCK_REASONS.has(probe.reason);

        gateByReceipt.set(row.receiptId, {
          reason: receiptBlocked ? probe.reason : 'trusted_product_spend',
          receiptSpendAllowed: !receiptBlocked,
        });
        gate = gateByReceipt.get(row.receiptId)!;

        if (!gate.receiptSpendAllowed) {
          return {
            ...row,
            lineTotal: null,
            monetaryTrusted: false,
            monetaryTrustReason: gate.reason,
          };
        }
      }

      if (!gate.receiptSpendAllowed) {
        return {
          ...row,
          lineTotal: null,
          monetaryTrusted: false,
          monetaryTrustReason: gate.reason,
        };
      }

      const prepared =
        preparedForRow ?? resolvePrepared(input, row.receiptId);
      const projected = projectTrustedConsumerItemAmountWithPreparedReceipt(
        input,
        prepared
      );
      if (!projected.trusted || projected.amount == null) {
        return {
          ...row,
          lineTotal: null,
          monetaryTrusted: false,
          monetaryTrustReason: projected.reason,
        };
      }

      return {
        ...row,
        lineTotal: projected.amount,
        monetaryTrusted: true,
        monetaryTrustReason: projected.reason,
      };
    });
  } finally {
    lastBulkStatsForTests = {
      receiptContextBuildCount,
      receiptContextReuseCount,
    };
    preparedByReceipt.clear();
    gateByReceipt.clear();
  }
}

/**
 * Aggregate trusted spend across ALL qualifying occurrences.
 * Coverage is evaluated before currency bucketing — UNKNOWN/missing currency
 * or untrusted amount makes Total spend incomplete.
 */
export function aggregateTrustedProductSpend(rows: readonly {
  lineTotal: number | null;
  monetaryTrusted?: boolean;
  currency?: string | null;
}[]): {
  totalSpend: number | null;
  currency: string | null;
  currencyTotals: Array<{ currency: string; totalSpend: number }>;
  monetaryCoverageComplete: boolean;
} {
  if (rows.length === 0) {
    return {
      totalSpend: null,
      currency: null,
      currencyTotals: [],
      monetaryCoverageComplete: true,
    };
  }

  let monetaryCoverageComplete = true;
  const currencyBuckets = new Map<string, number>();

  for (const row of rows) {
    const trustedAmount =
      row.monetaryTrusted !== false &&
      row.lineTotal != null &&
      Number.isFinite(Number(row.lineTotal));
    const currencyOk = isTrustedReceiptCurrency(row.currency);

    if (!trustedAmount || !currencyOk) {
      monetaryCoverageComplete = false;
      continue;
    }

    const currency = normalizeReceiptCurrency(row.currency)!;
    currencyBuckets.set(
      currency,
      (currencyBuckets.get(currency) ?? 0) + Number(row.lineTotal)
    );
  }

  if (!monetaryCoverageComplete) {
    return {
      totalSpend: null,
      currency: null,
      currencyTotals: [],
      monetaryCoverageComplete: false,
    };
  }

  const currencyTotals = [...currencyBuckets.entries()].map(
    ([currency, totalSpend]) => ({ currency, totalSpend })
  );
  const single = currencyTotals.length === 1 ? currencyTotals[0]! : null;
  return {
    totalSpend: single ? single.totalSpend : null,
    currency: single?.currency ?? null,
    currencyTotals,
    monetaryCoverageComplete: true,
  };
}
