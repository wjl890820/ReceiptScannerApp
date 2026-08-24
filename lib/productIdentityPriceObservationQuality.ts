/**
 * Product Identity Batch 5B — Price Observation Quality Gate.
 *
 * Runs before any price history / trend consumer.
 * Detect + flag + suppress strong trend. Never rewrite receipt truth / OCR qty.
 */

import type { ProductAttributes } from './productIdentityContract';
import { getAttributeValue } from './universalProductSpecParser';
import { computePurchaseUnitPrice } from './productIdentityPriceComparison';

export const PRODUCT_IDENTITY_PRICE_QUALITY_VERSION =
  'meruno-product-identity-price-quality-v1' as const;

export type PriceObservationQualityLevel =
  | 'trusted'
  | 'usable_with_caution'
  | 'suspected_anomaly'
  | 'invalid';

export type PriceObservationQualityReason =
  | 'ok'
  | 'invalid_price'
  | 'invalid_quantity'
  | 'discount_or_non_product_row'
  | 'suspected_quantity_ocr_anomaly'
  | 'high_variance_variable_price'
  | 'insufficient_history_for_anomaly_check';

export type PriceObservationQualityInput = {
  lineTotal: number | null | undefined;
  quantity: number | null | undefined;
  /** Peer purchase-unit prices on the same MerchantProduct (excluding self). */
  peerPurchaseUnitPrices?: readonly number[];
  attributes?: ProductAttributes | null;
  rawName?: string | null;
  isNonProductRow?: boolean;
};

export type PriceObservationQualityResult = {
  usable: boolean;
  /** Chart / history list (trusted | usable_with_caution). */
  includeInHistory: boolean;
  /** latest-vs-previous / 値上がり Insights. */
  includeInTrend: boolean;
  quality: PriceObservationQualityLevel;
  reasons: PriceObservationQualityReason[];
  rawPurchaseUnitPrice: number | null;
  /** Same as raw for V1 — we do not auto-correct OCR. */
  effectivePurchaseUnitPrice: number | null;
  quantityConfidence: number | null;
  potentialOutlier: boolean;
  suspectedIntegerMultiple: number | null;
  qualityVersion: typeof PRODUCT_IDENTITY_PRICE_QUALITY_VERSION;
};

const INTEGER_MULTIPLES = [2, 3, 4, 5, 6, 8, 10] as const;
const MULTIPLE_REL_TOL = 0.06;
const MAX_PEER_CV_FOR_ANOMALY = 0.18;
const MIN_PEERS_FOR_ANOMALY = 3;

function positiveFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function coeffOfVariation(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (!(mean > 0)) return Number.POSITIVE_INFINITY;
  const variance =
    nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

function nearIntegerMultiple(ratio: number): number | null {
  if (!positiveFinite(ratio)) return null;
  for (const k of INTEGER_MULTIPLES) {
    if (Math.abs(ratio - k) / k <= MULTIPLE_REL_TOL) return k;
    const inv = 1 / k;
    if (Math.abs(ratio - inv) / inv <= MULTIPLE_REL_TOL) return inv;
  }
  return null;
}

function numAttr(
  attrs: ProductAttributes | null | undefined,
  dim: string
): number | null {
  if (!attrs) return null;
  const v = getAttributeValue(attrs, dim);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Variable-price / weighable: prefer attributes + variance (no family === meat).
 * When unsure → do not flag quantity anomaly.
 */
export function looksLikeVariableUnitPriceProduct(input: {
  attributes?: ProductAttributes | null;
  rawName?: string | null;
  peerPurchaseUnitPrices?: readonly number[];
}): boolean {
  const attrs = input.attributes ?? null;
  const hasMass = numAttr(attrs, 'mass') != null;
  const hasVolume = numAttr(attrs, 'volume') != null;
  const hasCount = numAttr(attrs, 'count') != null;
  const hasRoll = numAttr(attrs, 'roll_count') != null;
  const hasLength = numAttr(attrs, 'length') != null;
  if (hasMass && !hasVolume && !hasCount && !hasRoll) return true;

  const peers = (input.peerPurchaseUnitPrices ?? []).filter(positiveFinite);
  if (peers.length >= MIN_PEERS_FOR_ANOMALY && coeffOfVariation(peers) >= 0.35) {
    return true;
  }

  const name = (input.rawName || '').toLowerCase();
  if (!hasMass && !hasVolume && !hasCount && !hasRoll && !hasLength) {
    if (/(肉|豚|牛|鶏|魚|刺身|切|ブロック|ステーキ|ミンチ)/.test(name)) {
      return true;
    }
  }
  return false;
}

export function evaluatePriceObservationQuality(
  input: PriceObservationQualityInput
): PriceObservationQualityResult {
  const reasons: PriceObservationQualityReason[] = [];

  if (input.isNonProductRow) {
    reasons.push('discount_or_non_product_row');
    return {
      usable: false,
      includeInHistory: false,
      includeInTrend: false,
      quality: 'invalid',
      reasons,
      rawPurchaseUnitPrice: null,
      effectivePurchaseUnitPrice: null,
      quantityConfidence: 0,
      potentialOutlier: false,
      suspectedIntegerMultiple: null,
      qualityVersion: PRODUCT_IDENTITY_PRICE_QUALITY_VERSION,
    };
  }

  const qty = input.quantity;
  if (qty != null && (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0)) {
    reasons.push('invalid_quantity');
  }
  const lineTotal = input.lineTotal;
  if (
    lineTotal != null &&
    (typeof lineTotal !== 'number' || !Number.isFinite(lineTotal) || lineTotal <= 0)
  ) {
    reasons.push('invalid_price');
  }

  const rawPurchaseUnitPrice = computePurchaseUnitPrice(
    input.lineTotal,
    input.quantity
  );
  if (rawPurchaseUnitPrice == null) {
    if (!reasons.includes('invalid_price') && !reasons.includes('invalid_quantity')) {
      reasons.push('invalid_price');
    }
    return {
      usable: false,
      includeInHistory: false,
      includeInTrend: false,
      quality: 'invalid',
      reasons,
      rawPurchaseUnitPrice: null,
      effectivePurchaseUnitPrice: null,
      quantityConfidence: 0,
      potentialOutlier: false,
      suspectedIntegerMultiple: null,
      qualityVersion: PRODUCT_IDENTITY_PRICE_QUALITY_VERSION,
    };
  }

  const peers = (input.peerPurchaseUnitPrices ?? []).filter(positiveFinite);
  let suspectedIntegerMultiple: number | null = null;
  let quality: PriceObservationQualityLevel = 'trusted';
  let quantityConfidence: number | null = 0.9;
  let potentialOutlier = false;

  if (peers.length < MIN_PEERS_FOR_ANOMALY) {
    reasons.push('insufficient_history_for_anomaly_check');
  } else if (
    looksLikeVariableUnitPriceProduct({
      attributes: input.attributes,
      rawName: input.rawName,
      peerPurchaseUnitPrices: peers,
    })
  ) {
    reasons.push('high_variance_variable_price');
    const med = median(peers);
    if (med > 0 && Math.abs(rawPurchaseUnitPrice - med) / med >= 0.5) {
      potentialOutlier = true;
      quality = 'usable_with_caution';
    }
  } else {
    const peerCv = coeffOfVariation(peers);
    const med = median(peers);
    if (peerCv <= MAX_PEER_CV_FOR_ANOMALY && med > 0) {
      const ratio = rawPurchaseUnitPrice / med;
      const multiple = nearIntegerMultiple(ratio);
      if (multiple != null && (multiple >= 2 || multiple <= 0.5)) {
        suspectedIntegerMultiple = multiple;
        reasons.push('suspected_quantity_ocr_anomaly');
        quality = 'suspected_anomaly';
        quantityConfidence = 0.25;
        potentialOutlier = true;
      } else if (Math.abs(ratio - 1) >= 0.45) {
        potentialOutlier = true;
        quality = 'usable_with_caution';
        quantityConfidence = 0.55;
      } else {
        reasons.push('ok');
      }
    } else {
      reasons.push('high_variance_variable_price');
      quality = 'usable_with_caution';
      quantityConfidence = 0.6;
    }
  }

  if (reasons.length === 0) reasons.push('ok');

  const includeInHistory =
    quality === 'trusted' || quality === 'usable_with_caution';
  const includeInTrend = quality === 'trusted';

  return {
    usable: includeInHistory,
    includeInHistory,
    includeInTrend,
    quality,
    reasons,
    rawPurchaseUnitPrice,
    effectivePurchaseUnitPrice: rawPurchaseUnitPrice,
    quantityConfidence,
    potentialOutlier,
    suspectedIntegerMultiple,
    qualityVersion: PRODUCT_IDENTITY_PRICE_QUALITY_VERSION,
  };
}

export type MerchantProductHistoryEligibility = {
  hasMerchantProductIdentity: boolean;
  observationCount: number;
  historyUsableCount: number;
  trendTrustedCount: number;
  distinctPurchaseDates: number;
  priceHistoryEligible: boolean;
  simpleDeltaEligible: boolean;
  trendInsightEligible: boolean;
  qualityExcludedCount: number;
  suspectedAnomalyCount: number;
};

function dayKey(ms: number): string {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return String(ms);
  }
}

/**
 * identityCapability ≠ priceHistoryEligibility.
 * same_merchant_product alone does not imply showable history.
 */
export function evaluateMerchantProductHistoryEligibility(input: {
  merchantProductId: string | null | undefined;
  observations: Array<{
    occurredAt: number;
    quality: PriceObservationQualityLevel;
  }>;
}): MerchantProductHistoryEligibility {
  const hasMerchantProductIdentity = Boolean(input.merchantProductId);
  const observationCount = input.observations.length;
  const historyUsable = input.observations.filter(
    (o) => o.quality === 'trusted' || o.quality === 'usable_with_caution'
  );
  const trendTrusted = input.observations.filter((o) => o.quality === 'trusted');
  const suspectedAnomalyCount = input.observations.filter(
    (o) => o.quality === 'suspected_anomaly'
  ).length;
  const qualityExcludedCount = input.observations.filter(
    (o) => o.quality === 'invalid' || o.quality === 'suspected_anomaly'
  ).length;
  const dates = new Set(
    historyUsable
      .filter((o) => positiveFinite(o.occurredAt))
      .map((o) => dayKey(o.occurredAt))
  );

  return {
    hasMerchantProductIdentity,
    observationCount,
    historyUsableCount: historyUsable.length,
    trendTrustedCount: trendTrusted.length,
    distinctPurchaseDates: dates.size,
    priceHistoryEligible:
      hasMerchantProductIdentity && historyUsable.length >= 2,
    simpleDeltaEligible:
      hasMerchantProductIdentity && trendTrusted.length >= 2,
    trendInsightEligible:
      hasMerchantProductIdentity &&
      trendTrusted.length >= 3 &&
      dates.size >= 2,
    qualityExcludedCount,
    suspectedAnomalyCount,
  };
}
