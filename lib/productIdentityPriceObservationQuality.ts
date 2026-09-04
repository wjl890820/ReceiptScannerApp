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
  /**
   * Optional leave-one-out peer stats (prepared path).
   * When set, peerPurchaseUnitPrices is ignored for median/CV decisions.
   */
  preparedPeerStats?: LeaveOneOutPeerStats | null;
  attributes?: ProductAttributes | null;
  rawName?: string | null;
  isNonProductRow?: boolean;
  /** When true, reciprocal half/integer price drop may be treated as qty OCR anomaly. */
  quantityOcrCorroborated?: boolean;
};

/**
 * Resolve independent quantity-OCR corroboration for the quality gate.
 * Never invents evidence from price ratios alone (V1 safe).
 * True only when the caller supplies explicit provenance/mismatch evidence.
 */
export function resolveQuantityOcrCorroboration(input: {
  quantityOcrCorroborated?: boolean | null;
  quantitySource?: 'ocr' | 'user' | 'default' | null;
  quantityMismatchEvidence?: boolean | null;
}): boolean {
  if (input.quantityOcrCorroborated === true) return true;
  // Explicit OCR provenance + independent mismatch flag (not price-derived).
  if (
    input.quantitySource === 'ocr' &&
    input.quantityMismatchEvidence === true
  ) {
    return true;
  }
  return false;
}

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

/** Test/production instrumentation: full-bucket peer sorts (prepare once). */
let peerBucketSortCount = 0;
let peerFullScanCount = 0;
let peerFirstIndexMapBuildCount = 0;
let peerO1MedianLookups = 0;
let peerO1VarianceLookups = 0;
/** Must stay 0 on prepared leave-one-out path (no per-candidate B-scan). */
let peerCandidateLinearScans = 0;

export function beginPeerQualityWorkCounting(): void {
  peerBucketSortCount = 0;
  peerFullScanCount = 0;
  peerFirstIndexMapBuildCount = 0;
  peerO1MedianLookups = 0;
  peerO1VarianceLookups = 0;
  peerCandidateLinearScans = 0;
}

export function getPeerQualityWorkCounts(): {
  peerBucketSortCount: number;
  peerFullScanCount: number;
  peerFirstIndexMapBuildCount: number;
  peerO1MedianLookups: number;
  peerO1VarianceLookups: number;
  peerCandidateLinearScans: number;
} {
  return {
    peerBucketSortCount,
    peerFullScanCount,
    peerFirstIndexMapBuildCount,
    peerO1MedianLookups,
    peerO1VarianceLookups,
    peerCandidateLinearScans,
  };
}

export function endPeerQualityWorkCounting(): {
  peerBucketSortCount: number;
  peerFullScanCount: number;
  peerFirstIndexMapBuildCount: number;
  peerO1MedianLookups: number;
  peerO1VarianceLookups: number;
  peerCandidateLinearScans: number;
} {
  const snapshot = getPeerQualityWorkCounts();
  beginPeerQualityWorkCounting();
  return snapshot;
}

export type PreparedPeerPriceBucket = {
  /** Sorted ascending; positive-finite only (same filter as evaluate). */
  sorted: readonly number[];
  count: number;
  /** Welford running mean of sorted values. */
  mean: number;
  /** Welford M2 (sum of squared deviations). */
  M2: number;
  /**
   * value → first index in sorted (legacy indexOf-first-occurrence on the
   * positive-finite multiset; equal values share one skip index for stats).
   */
  firstIndexByValue: ReadonlyMap<number, number>;
};

export type LeaveOneOutPeerStats = {
  count: number;
  median: number;
  coeffOfVariation: number;
};

/**
 * Legacy leave-one-out peer array: copy → indexOf(exclude) → splice once.
 * Used for equivalence tests against prepared stats.
 */
export function legacyLeaveOneOutPeerPrices(
  allPrices: readonly number[],
  excludeValue: number | null | undefined
): number[] {
  peerFullScanCount += 1;
  const peers = allPrices.filter(positiveFinite);
  if (excludeValue != null && positiveFinite(excludeValue)) {
    const idx = peers.indexOf(excludeValue);
    if (idx >= 0) peers.splice(idx, 1);
  }
  return peers;
}

/** Legacy population CV (authoritative classification reference for ordinary fixtures). */
export function legacyPeerCoeffOfVariation(peers: readonly number[]): number {
  return coeffOfVariation([...peers]);
}

export function preparePeerPriceBucket(
  prices: readonly number[]
): PreparedPeerPriceBucket {
  peerBucketSortCount += 1;
  const sorted = prices.filter(positiveFinite).slice().sort((a, b) => a - b);
  let mean = 0;
  let M2 = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const x = sorted[i]!;
    const n = i + 1;
    const delta = x - mean;
    mean += delta / n;
    M2 += delta * (x - mean);
  }
  peerFirstIndexMapBuildCount += 1;
  const firstIndexByValue = new Map<number, number>();
  for (let i = 0; i < sorted.length; i += 1) {
    const value = sorted[i]!;
    if (!firstIndexByValue.has(value)) {
      firstIndexByValue.set(value, i);
    }
  }
  return {
    sorted,
    count: sorted.length,
    mean,
    M2,
    firstIndexByValue,
  };
}

/** O(1) kth element among sorted values excluding skipIndex. */
function kthAfterSkipO1(
  sorted: readonly number[],
  skipIndex: number,
  k: number
): number {
  peerO1MedianLookups += 1;
  const originalIndex = k < skipIndex ? k : k + 1;
  return sorted[originalIndex]!;
}

function medianSkippingIndexO1(
  sorted: readonly number[],
  skipIndex: number
): number {
  const n = sorted.length - 1;
  if (n <= 0) return 0;
  if (n % 2 === 1) {
    return kthAfterSkipO1(sorted, skipIndex, Math.floor(n / 2));
  }
  const left = kthAfterSkipO1(sorted, skipIndex, n / 2 - 1);
  const right = kthAfterSkipO1(sorted, skipIndex, n / 2);
  return (left + right) / 2;
}

function medianOfFullSorted(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function cvFromMeanM2(count: number, mean: number, M2: number): number {
  peerO1VarianceLookups += 1;
  if (count < 2) return 0;
  if (!(mean > 0)) return Number.POSITIVE_INFINITY;
  let variance = M2 / count;
  // Tiny negative noise from floating error only; never hide material negatives.
  if (variance < 0 && variance > -1e-12 * Math.max(1, mean * mean)) {
    variance = 0;
  }
  if (!(variance >= 0) || !Number.isFinite(variance)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt(variance) / mean;
}

function statsFromFullBucket(bucket: PreparedPeerPriceBucket): LeaveOneOutPeerStats {
  if (bucket.count === 0) {
    return { count: 0, median: 0, coeffOfVariation: 0 };
  }
  if (bucket.count < 2) {
    return {
      count: bucket.count,
      median: bucket.sorted[0] ?? 0,
      coeffOfVariation: 0,
    };
  }
  return {
    count: bucket.count,
    median: medianOfFullSorted(bucket.sorted),
    coeffOfVariation: cvFromMeanM2(bucket.count, bucket.mean, bucket.M2),
  };
}

/**
 * Leave-one-out peer stats matching indexOf+splice(first occurrence) semantics.
 * After preparePeerPriceBucket: O(1) median + O(1) Welford variance per candidate.
 */
export function leaveOneOutPeerStats(
  bucket: PreparedPeerPriceBucket,
  excludeValue: number | null | undefined
): LeaveOneOutPeerStats {
  if (
    excludeValue == null ||
    !positiveFinite(excludeValue) ||
    bucket.count === 0
  ) {
    return statsFromFullBucket(bucket);
  }
  const skipIndex = bucket.firstIndexByValue.get(excludeValue);
  if (skipIndex == null) {
    return statsFromFullBucket(bucket);
  }
  const count = bucket.count - 1;
  if (count === 0) {
    return { count: 0, median: 0, coeffOfVariation: 0 };
  }
  if (count === 1) {
    return {
      count: 1,
      median: medianSkippingIndexO1(bucket.sorted, skipIndex),
      coeffOfVariation: 0,
    };
  }
  // Welford leave-one-out removal of X (population variance).
  const x = excludeValue;
  const n = bucket.count;
  const mean = bucket.mean;
  const newMean = (n * mean - x) / count;
  const newM2 = bucket.M2 - (x - mean) * (x - newMean);
  return {
    count,
    median: medianSkippingIndexO1(bucket.sorted, skipIndex),
    coeffOfVariation: cvFromMeanM2(count, newMean, newM2),
  };
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
  preparedPeerCount?: number;
  preparedPeerCv?: number;
}): boolean {
  const attrs = input.attributes ?? null;
  const hasMass = numAttr(attrs, 'mass') != null;
  const hasVolume = numAttr(attrs, 'volume') != null;
  const hasCount = numAttr(attrs, 'count') != null;
  const hasRoll = numAttr(attrs, 'roll_count') != null;
  const hasLength = numAttr(attrs, 'length') != null;
  if (hasMass && !hasVolume && !hasCount && !hasRoll) return true;

  if (
    typeof input.preparedPeerCount === 'number' &&
    typeof input.preparedPeerCv === 'number'
  ) {
    if (
      input.preparedPeerCount >= MIN_PEERS_FOR_ANOMALY &&
      input.preparedPeerCv >= 0.35
    ) {
      return true;
    }
  } else {
    const peers = (input.peerPurchaseUnitPrices ?? []).filter(positiveFinite);
    if (peers.length >= MIN_PEERS_FOR_ANOMALY && coeffOfVariation(peers) >= 0.35) {
      return true;
    }
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

  const prepared = input.preparedPeerStats ?? null;
  const peers = prepared
    ? null
    : (input.peerPurchaseUnitPrices ?? []).filter(positiveFinite);
  const peerCount = prepared ? prepared.count : peers!.length;
  const peerMed = prepared ? prepared.median : median(peers!);
  const peerCv = prepared
    ? prepared.coeffOfVariation
    : coeffOfVariation(peers!);

  let suspectedIntegerMultiple: number | null = null;
  let quality: PriceObservationQualityLevel = 'trusted';
  let quantityConfidence: number | null = 0.9;
  let potentialOutlier = false;

  if (peerCount < MIN_PEERS_FOR_ANOMALY) {
    reasons.push('insufficient_history_for_anomaly_check');
  } else if (
    looksLikeVariableUnitPriceProduct({
      attributes: input.attributes,
      rawName: input.rawName,
      peerPurchaseUnitPrices: peers ?? undefined,
      preparedPeerCount: prepared?.count,
      preparedPeerCv: prepared?.coeffOfVariation,
    })
  ) {
    reasons.push('high_variance_variable_price');
    const med = peerMed;
    if (med > 0 && Math.abs(rawPurchaseUnitPrice - med) / med >= 0.5) {
      potentialOutlier = true;
      quality = 'usable_with_caution';
    }
  } else {
    const med = peerMed;
    if (peerCv <= MAX_PEER_CV_FOR_ANOMALY && med > 0) {
      const ratio = rawPurchaseUnitPrice / med;
      const multiple = nearIntegerMultiple(ratio);
      if (multiple != null && multiple >= 2) {
        // High-side integer multiple (e.g. 400→800): strong qty OCR suspicion.
        suspectedIntegerMultiple = multiple;
        reasons.push('suspected_quantity_ocr_anomaly');
        quality = 'suspected_anomaly';
        quantityConfidence = 0.25;
        potentialOutlier = true;
      } else if (multiple != null && multiple <= 0.5) {
        // Reciprocal low-side (e.g. 400→200): do not auto-suppress legitimate promotions.
        suspectedIntegerMultiple = multiple;
        potentialOutlier = true;
        if (input.quantityOcrCorroborated === true) {
          reasons.push('suspected_quantity_ocr_anomaly');
          quality = 'suspected_anomaly';
          quantityConfidence = 0.25;
        } else {
          reasons.push('high_variance_variable_price');
          quality = 'usable_with_caution';
          quantityConfidence = 0.55;
        }
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
