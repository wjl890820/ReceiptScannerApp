/**
 * Test-only Product Price History fixtures.
 * NOT imported by production code paths.
 */

import type { ReceiptAmountBasisAssessment } from './analysisFoundation/types';
import type { ReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/types';
import type { ProductDetailTarget } from './productDetailTarget';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryResult,
  type ProductPriceHistoryRow,
  type ReceiptEvidenceCache,
} from './productPriceHistory';

export function makeLegacyPriceRow(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> = {}
): ProductPriceHistoryRow {
  return {
    receiptId: `receipt-${id}`,
    itemId: `item-${id}`,
    sourceIndex: overrides.sourceIndex ?? 0,
    occurredAt: Number(String(id).replace(/\D/g, '')) || 1,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    displayName: `Product ${id}`,
    currency: 'JPY',
    lineTotal: overrides.lineTotal ?? 100,
    purchaseQuantity: overrides.purchaseQuantity ?? 1,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    grossLineAmount: null,
    priceObservationVersion: null,
    itemAmountEvidenceState: null,
    ...overrides,
  };
}

export function makeTrustedG3TestRow(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> = {}
): ProductPriceHistoryRow {
  const gross = overrides.grossLineAmount ?? overrides.lineTotal ?? 100;
  return {
    receiptId: `receipt-${id}`,
    itemId: `item-${id}`,
    sourceIndex: overrides.sourceIndex ?? 0,
    occurredAt: Number(String(id).replace(/\D/g, '')) || 1,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    displayName: overrides.displayName ?? `Product ${id}`,
    currency: overrides.currency === undefined ? 'JPY' : overrides.currency,
    lineTotal: overrides.lineTotal ?? gross,
    purchaseQuantity: overrides.purchaseQuantity ?? 1,
    productFamilyKey: overrides.productFamilyKey ?? null,
    volumeBaseMl: overrides.volumeBaseMl ?? null,
    weightBaseG: overrides.weightBaseG ?? null,
    countBase: overrides.countBase ?? null,
    grossLineAmount: gross,
    effectiveLineAmount: overrides.effectiveLineAmount ?? gross,
    priceObservationVersion: 1,
    itemAmountEvidenceState: 'coherent',
    amountProvenance: 'ocr_observed',
    evidenceCaptureVersion: 1,
    receiptAnalysisJson:
      overrides.receiptAnalysisJson ??
      JSON.stringify({
        items: [{ name: overrides.displayName ?? `Product ${id}`, lineTotal: gross, quantity: 1 }],
        evidenceCaptureVersion: 1,
        reconciliation: { ok: true },
        amount_mismatch: false,
      }),
    receiptUserItemsJson: overrides.receiptUserItemsJson ?? null,
    receiptUserEdited: overrides.receiptUserEdited ?? 0,
    receiptTotal: overrides.receiptTotal ?? gross,
    receiptFinalTotal: overrides.receiptFinalTotal ?? null,
    receiptTax: overrides.receiptTax ?? 8,
    receiptTaxIsKnown: overrides.receiptTaxIsKnown ?? 1,
    receiptCurrency: overrides.receiptCurrency ?? 'JPY',
    ...overrides,
  };
}

export function makeTrustedReceiptTestFields(
  receiptId: string,
  gross: number,
  basis: 'tax_included' | 'tax_excluded' = 'tax_included'
): Pick<
  ProductPriceHistoryRow,
  | 'receiptAnalysisJson'
  | 'receiptUserItemsJson'
  | 'receiptUserEdited'
  | 'receiptTotal'
  | 'receiptFinalTotal'
  | 'receiptTax'
  | 'receiptTaxIsKnown'
  | 'receiptCurrency'
> {
  void basis;
  return {
    receiptAnalysisJson: JSON.stringify({
      items: [{ name: '商品', lineTotal: gross, quantity: 1 }],
      evidenceCaptureVersion: 1,
    }),
    receiptUserItemsJson: null,
    receiptUserEdited: 0,
    receiptTotal: gross,
    receiptFinalTotal: null,
    receiptTax: 8,
    receiptTaxIsKnown: 1,
    receiptCurrency: 'JPY',
  };
}

function defaultTrustedEvidenceEntry(
  receiptId: string,
  basis: 'tax_included' | 'tax_excluded' = 'tax_included'
): {
  amountBasisAssessment: ReceiptAmountBasisAssessment;
  monetaryCoherenceEvidence: ReceiptMonetaryCoherenceEvidence;
} {
  return {
    amountBasisAssessment: {
      receiptId,
      basis,
      receiptTotal: 0,
      receiptTax: 0,
      analyticsItemSum: 0,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
      confidence: 'high',
      taxProvenance: 'trusted',
      exactComparisonTrusted: true,
      evidence: [],
      reasonCodes: [],
    },
    monetaryCoherenceEvidence: {
      receiptId,
      state: 'known_coherent',
      authoritativeLayer: 'ocr',
      discountOwnershipStatus: 'resolved',
      monetaryProvenanceSufficient: true,
      closureHypothesis: null,
      evidence: [],
      reasonCodes: [],
    },
  };
}

export function createTrustedReceiptTestCache(
  rows: readonly ProductPriceHistoryRow[],
  basisByReceipt: Record<string, 'tax_included' | 'tax_excluded'> = {}
): ReceiptEvidenceCache {
  const cache: ReceiptEvidenceCache = new Map();
  for (const row of rows) {
    if (cache.has(row.receiptId)) continue;
    cache.set(
      row.receiptId,
      defaultTrustedEvidenceEntry(
        row.receiptId,
        basisByReceipt[row.receiptId] ?? 'tax_included'
      )
    );
  }
  return cache;
}

export function applyTrustedG3TestDefaults(
  row: ProductPriceHistoryRow
): ProductPriceHistoryRow {
  const token = row.itemId.replace(/^item-/, '') || row.receiptId;
  return makeTrustedG3TestRow(token, row);
}

export function buildTrustedProductPriceHistoryForTests(
  target: ProductDetailTarget,
  rows: ProductPriceHistoryRow[],
  options: {
    basisByReceipt?: Record<string, 'tax_included' | 'tax_excluded'>;
    monetaryOverrides?: Record<string, Partial<ReceiptMonetaryCoherenceEvidence>>;
    canonicalDuplicateSelectionApplied?: boolean;
  } = {}
): ProductPriceHistoryResult {
  const trustedRows = rows.map((row) =>
    row.priceObservationVersion === 1 && row.grossLineAmount != null
      ? row
      : makeTrustedG3TestRow(row.itemId.replace(/^item-/, ''), row)
  );
  const cache = createTrustedReceiptTestCache(
    trustedRows,
    options.basisByReceipt ?? {}
  );
  if (options.monetaryOverrides) {
    for (const [receiptId, overrides] of Object.entries(
      options.monetaryOverrides
    )) {
      const existing = cache.get(receiptId);
      if (!existing) continue;
      cache.set(receiptId, {
        ...existing,
        monetaryCoherenceEvidence: {
          ...existing.monetaryCoherenceEvidence,
          ...overrides,
        },
      });
    }
  }
  return buildProductPriceHistory(target, trustedRows, {
    receiptEvidenceCache: cache,
    canonicalDuplicateSelectionApplied:
      options.canonicalDuplicateSelectionApplied === true,
  });
}
