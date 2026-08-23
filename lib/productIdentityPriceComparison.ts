/**
 * Product Identity Batch 5A — Universal Price Comparison Engine (shadow only).
 *
 * Identity Resolver answers "what is this?"
 * Comparison Engine answers "can these prices be compared, and how?"
 *
 * Does NOT: create/merge MerchantProducts, change identity confidence,
 * call Gemini, invent CanonicalProduct / SKU, or touch UI.
 */

import type { ProductAttributes } from './productIdentityContract';
import { getAttributeValue } from './universalProductSpecParser';
import { isPurchaseUnitPriceUsable } from './productIdentity';

export const PRODUCT_IDENTITY_PRICE_COMPARISON_VERSION =
  'meruno-product-identity-price-comparison-v1' as const;

/**
 * Comparison strength ladder (strongest → weakest).
 * Presentation language must differ by strategy (see PRESENTATION_HINTS).
 */
export type PriceComparisonStrategy =
  | 'same_sku'
  | 'same_product'
  | 'same_merchant_product'
  | 'family_spec'
  | 'unit_price'
  | 'no_comparison';

export const PRICE_COMPARISON_STRATEGY_RANK: Record<PriceComparisonStrategy, number> = {
  same_sku: 100,
  same_product: 80,
  same_merchant_product: 60,
  family_spec: 40,
  unit_price: 20,
  no_comparison: 0,
};

/** Internal measurement bases for unit-price normalization. */
export type MeasurementDimension =
  | 'mass' // JPY/g
  | 'volume' // JPY/ml
  | 'count' // JPY/count
  | 'length' // JPY/mm
  | 'roll_count'; // JPY/roll

export type PriceComparisonRejectionReason =
  | 'invalid_price'
  | 'invalid_quantity'
  | 'discount_or_non_product_row'
  | 'insufficient_identity'
  | 'no_repeated_identity'
  | 'no_structural_spec'
  | 'unsupported_measurement'
  | 'structural_conflict'
  | 'no_sku'
  | 'no_canonical_product'
  | 'cross_merchant_without_canonical';

export type PriceComparisonInput = {
  rawName: string;
  merchantKey: string;
  /** Paid line amount (SSOT: effective/line total after known discounts). */
  lineTotal: number | null | undefined;
  quantity: number | null | undefined;
  merchantProductId?: string | null;
  canonicalProductId?: string | null;
  skuId?: string | null;
  identityLevel?: string | null;
  attributes?: ProductAttributes | null;
  /** Legacy family key when present (semantic capability only). */
  productFamilyKey?: string | null;
  /** True when row is a discount / tax / subtotal line. */
  isNonProductRow?: boolean;
};

export type NormalizedUnitPrice = {
  dimension: MeasurementDimension;
  /** Internal base: JPY per g|ml|count|mm|roll */
  unitPriceBase: number;
  /** Total measure contributing to denominator (after pack × qty). */
  totalMeasure: number;
  unitLabel: string;
  /** Display helpers (not identity). */
  displayPer100?: number | null;
  displayPer1000?: number | null;
};

export type PriceComparisonEligibility = {
  eligible: boolean;
  strongestStrategy: PriceComparisonStrategy;
  /** All strategies this observation supports (capability set). */
  capabilities: PriceComparisonStrategy[];
  reasons: string[];
  rejectionReasons: PriceComparisonRejectionReason[];
  identityLevel: string | null;
  measurementDimension: MeasurementDimension | null;
  /** SSOT purchase unit price = lineTotal / quantity */
  purchaseUnitPrice: number | null;
  normalizedUnitPrice: NormalizedUnitPrice | null;
  confidence: number;
  presentationHint: string;
  comparisonVersion: typeof PRODUCT_IDENTITY_PRICE_COMPARISON_VERSION;
};

export const PRICE_COMPARISON_PRESENTATION_HINTS: Record<
  PriceComparisonStrategy,
  string
> = {
  same_sku: 'exact_sku_price_history',
  same_product: 'same_product_price_history',
  same_merchant_product: 'merchant_local_product_price_history',
  family_spec: 'same_family_spec_price_reference',
  unit_price: 'unit_price_reference_only',
  no_comparison: 'no_price_comparison',
};

function positiveFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Price SSOT for Batch 5A:
 * purchaseUnitPrice = lineTotal / quantity
 * Prefer lineTotal (paid amount) over OCR unitPrice.
 */
export function computePurchaseUnitPrice(
  lineTotal: number | null | undefined,
  quantity: number | null | undefined
): number | null {
  if (!isPurchaseUnitPriceUsable({ lineTotal: lineTotal as number, purchaseQuantity: quantity as number })) {
    return null;
  }
  const q = quantity as number;
  const t = lineTotal as number;
  const v = t / q;
  return positiveFinite(v) ? v : null;
}

function numAttr(attrs: ProductAttributes | null | undefined, dim: string): number | null {
  if (!attrs) return null;
  const v = getAttributeValue(attrs, dim);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Derive comparable physical measure from ProductAttributes (family-agnostic).
 * Multipack: unit volume/mass × pack_count → total measure per sold unit.
 */
export function deriveMeasurementFromAttributes(
  attrs: ProductAttributes | null | undefined
): {
  dimension: MeasurementDimension;
  measurePerSoldUnit: number;
  unitLabel: string;
} | null {
  if (!attrs) return null;
  const pack = numAttr(attrs, 'pack_count');
  const packMul = pack != null && pack > 1 ? pack : 1;

  const volumeMl = numAttr(attrs, 'volume');
  if (volumeMl != null) {
    return {
      dimension: 'volume',
      measurePerSoldUnit: volumeMl * packMul,
      unitLabel: 'ml',
    };
  }
  const massG = numAttr(attrs, 'mass');
  if (massG != null) {
    return {
      dimension: 'mass',
      measurePerSoldUnit: massG * packMul,
      unitLabel: 'g',
    };
  }
  const rolls = numAttr(attrs, 'roll_count');
  if (rolls != null) {
    return {
      dimension: 'roll_count',
      measurePerSoldUnit: rolls * packMul,
      unitLabel: 'roll',
    };
  }
  const lengthMm = numAttr(attrs, 'length');
  if (lengthMm != null) {
    return {
      dimension: 'length',
      measurePerSoldUnit: lengthMm * packMul,
      unitLabel: 'mm',
    };
  }
  const count = numAttr(attrs, 'count');
  if (count != null) {
    return {
      dimension: 'count',
      measurePerSoldUnit: count * packMul,
      unitLabel: 'count',
    };
  }
  return null;
}

export function computeNormalizedUnitPrice(
  lineTotal: number,
  quantity: number,
  attrs: ProductAttributes | null | undefined
): NormalizedUnitPrice | null {
  const measure = deriveMeasurementFromAttributes(attrs);
  if (!measure) return null;
  if (!positiveFinite(lineTotal) || !positiveFinite(quantity)) return null;
  const totalMeasure = measure.measurePerSoldUnit * quantity;
  if (!positiveFinite(totalMeasure)) return null;
  const unitPriceBase = lineTotal / totalMeasure;
  if (!positiveFinite(unitPriceBase)) return null;

  const out: NormalizedUnitPrice = {
    dimension: measure.dimension,
    unitPriceBase,
    totalMeasure,
    unitLabel: measure.unitLabel,
    displayPer100: null,
    displayPer1000: null,
  };
  if (measure.dimension === 'volume' || measure.dimension === 'mass') {
    out.displayPer100 = unitPriceBase * 100;
    out.displayPer1000 = unitPriceBase * 1000;
  }
  return out;
}

function confidenceForStrategy(
  strategy: PriceComparisonStrategy,
  hasMeasure: boolean
): number {
  switch (strategy) {
    case 'same_sku':
      return 0.98;
    case 'same_product':
      return 0.92;
    case 'same_merchant_product':
      return 0.85;
    case 'family_spec':
      return hasMeasure ? 0.7 : 0.55;
    case 'unit_price':
      return 0.45;
    default:
      return 0;
  }
}

/**
 * Evaluate comparison eligibility for a single observation.
 * Does not look at other observations — history aggregation is separate.
 */
export function evaluatePriceComparisonEligibility(
  input: PriceComparisonInput
): PriceComparisonEligibility {
  const rejectionReasons: PriceComparisonRejectionReason[] = [];
  const capabilities: PriceComparisonStrategy[] = [];
  const reasons: string[] = [];

  if (input.isNonProductRow) {
    rejectionReasons.push('discount_or_non_product_row');
  }

  const qty = input.quantity;
  if (qty != null && (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0)) {
    rejectionReasons.push('invalid_quantity');
  }

  const lineTotal = input.lineTotal;
  if (
    lineTotal != null &&
    (typeof lineTotal !== 'number' || !Number.isFinite(lineTotal) || lineTotal <= 0)
  ) {
    rejectionReasons.push('invalid_price');
  }

  const purchaseUnitPrice = computePurchaseUnitPrice(input.lineTotal, input.quantity);
  if (purchaseUnitPrice == null && !rejectionReasons.includes('invalid_price')) {
    if (!positiveFinite(lineTotal as number) || !positiveFinite(qty as number)) {
      rejectionReasons.push('invalid_price');
    }
  }

  const measure = deriveMeasurementFromAttributes(input.attributes ?? null);
  const normalizedUnitPrice =
    purchaseUnitPrice != null && positiveFinite(lineTotal as number) && positiveFinite(qty as number)
      ? computeNormalizedUnitPrice(lineTotal as number, qty as number, input.attributes)
      : null;

  const hardBlocked =
    rejectionReasons.includes('discount_or_non_product_row') ||
    rejectionReasons.includes('invalid_price') ||
    rejectionReasons.includes('invalid_quantity');

  if (!hardBlocked && purchaseUnitPrice != null) {
    if (input.skuId) {
      capabilities.push('same_sku');
      reasons.push('has_sku_id');
    }
    if (input.canonicalProductId) {
      capabilities.push('same_product');
      reasons.push('has_canonical_product_id');
    }
    if (input.merchantProductId) {
      capabilities.push('same_merchant_product');
      reasons.push('has_merchant_product_id');
    }

    const family = (input.productFamilyKey || '').trim();
    if (family && measure) {
      capabilities.push('family_spec');
      reasons.push(`family_spec:${family}:${measure.dimension}`);
    }

    if (normalizedUnitPrice) {
      capabilities.push('unit_price');
      reasons.push(`unit_price:${normalizedUnitPrice.dimension}`);
    } else if (!measure) {
      rejectionReasons.push('no_structural_spec');
    }
  }

  if (!input.merchantProductId && !input.canonicalProductId && !input.skuId) {
    if (!capabilities.includes('family_spec') && !capabilities.includes('unit_price')) {
      rejectionReasons.push('insufficient_identity');
    }
  }

  let strongest: PriceComparisonStrategy = 'no_comparison';
  for (const c of capabilities) {
    if (PRICE_COMPARISON_STRATEGY_RANK[c] > PRICE_COMPARISON_STRATEGY_RANK[strongest]) {
      strongest = c;
    }
  }

  if (strongest === 'no_comparison' && rejectionReasons.length === 0) {
    rejectionReasons.push('insufficient_identity');
  }

  const eligible = strongest !== 'no_comparison';
  return {
    eligible,
    strongestStrategy: strongest,
    capabilities,
    reasons,
    rejectionReasons: [...new Set(rejectionReasons)],
    identityLevel: input.identityLevel ?? null,
    measurementDimension: measure?.dimension ?? null,
    purchaseUnitPrice,
    normalizedUnitPrice,
    confidence: confidenceForStrategy(strongest, !!measure),
    presentationHint: PRICE_COMPARISON_PRESENTATION_HINTS[strongest],
    comparisonVersion: PRODUCT_IDENTITY_PRICE_COMPARISON_VERSION,
  };
}

export type MerchantProductPricePoint = {
  receiptId: string;
  itemSourceIndex: number;
  occurredAt: number;
  rawName: string;
  merchantKey: string;
  merchantProductId: string;
  lineTotal: number;
  quantity: number;
  purchaseUnitPrice: number;
  normalizedUnitPrice: NormalizedUnitPrice | null;
};

export type MerchantProductPriceHistory = {
  merchantProductId: string;
  merchantKey: string;
  points: MerchantProductPricePoint[];
  min: number;
  max: number;
  mean: number;
  median: number;
  latest: number;
  previous: number | null;
  latestVsPreviousPct: number | null;
  latestVsMedianPct: number | null;
  potentialOutliers: number[];
};

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Build merchant-local price history for one MerchantProduct.
 * Requires ≥2 points for a usable history; trend fields need ≥3.
 */
export function buildMerchantProductPriceHistory(
  merchantProductId: string,
  merchantKey: string,
  pointsIn: MerchantProductPricePoint[]
): MerchantProductPriceHistory | null {
  const points = [...pointsIn].sort(
    (a, b) =>
      a.occurredAt - b.occurredAt ||
      a.receiptId.localeCompare(b.receiptId) ||
      a.itemSourceIndex - b.itemSourceIndex
  );
  if (points.length < 2) return null;

  const prices = points.map((p) => p.purchaseUnitPrice);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const med = median(prices);
  const latest = prices[prices.length - 1]!;
  const previous = prices.length >= 2 ? prices[prices.length - 2]! : null;
  const latestVsPreviousPct =
    previous != null && previous > 0 ? ((latest - previous) / previous) * 100 : null;
  const latestVsMedianPct = med > 0 ? ((latest - med) / med) * 100 : null;

  // Diagnostic only — never delete.
  const potentialOutliers: number[] = [];
  if (prices.length >= 3) {
    const m = med;
    for (let i = 0; i < prices.length; i++) {
      const p = prices[i]!;
      if (m > 0 && Math.abs(p - m) / m >= 0.5) potentialOutliers.push(i);
    }
  }

  return {
    merchantProductId,
    merchantKey,
    points,
    min: Math.min(...prices),
    max: Math.max(...prices),
    mean,
    median: med,
    latest,
    previous,
    latestVsPreviousPct,
    latestVsMedianPct,
    potentialOutliers,
  };
}

/**
 * Legacy eligibility flags for dual-run (does not mutate legacy pipeline).
 */
export function evaluateLegacyPriceEligibility(input: {
  lineTotal: number | null | undefined;
  quantity: number | null | undefined;
  skuKey?: string | null;
  productFamilyKey?: string | null;
  volumeBaseMl?: number | null;
  weightBaseG?: number | null;
  countBase?: number | null;
}): {
  purchaseUnitUsable: boolean;
  skuHistoryUsable: boolean;
  familyNormalizedUsable: boolean;
} {
  const purchaseUnitUsable = isPurchaseUnitPriceUsable({
    lineTotal: input.lineTotal as number,
    purchaseQuantity: input.quantity as number,
  });
  const skuHistoryUsable =
    purchaseUnitUsable && Boolean(input.skuKey && String(input.skuKey).trim());

  const family = (input.productFamilyKey || '').trim().toLowerCase();
  const volumeFamilies = new Set(['milk', 'coffee', 'tea', 'water', 'cola']);
  const countFamilies = new Set(['eggs']);
  const weightFamilies = new Set(['rice']);

  let familyNormalizedUsable = false;
  if (purchaseUnitUsable && family) {
    if (volumeFamilies.has(family) && positiveFinite(input.volumeBaseMl)) {
      familyNormalizedUsable = true;
    } else if (countFamilies.has(family) && positiveFinite(input.countBase)) {
      familyNormalizedUsable = true;
    } else if (weightFamilies.has(family) && positiveFinite(input.weightBaseG)) {
      familyNormalizedUsable = true;
    }
  }

  return { purchaseUnitUsable, skuHistoryUsable, familyNormalizedUsable };
}
