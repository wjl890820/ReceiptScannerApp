/**
 * Product Identity Batch 5A — Shadow dual-run: Universal Comparison vs Legacy.
 * Memory/shadow only. No DB writes. Gemini calls = 0. No UI changes.
 */

import {
  resolveReceiptItemIdentity,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type ProductIdentityStore,
} from './productIdentityStore';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import type { ShadowDatasetSummary, ShadowIdentityObservation } from './productIdentityShadowAudit';
import {
  buildMerchantProductPriceHistory,
  evaluateLegacyPriceEligibility,
  evaluatePriceComparisonEligibility,
  PRODUCT_IDENTITY_PRICE_COMPARISON_VERSION,
  type MeasurementDimension,
  type MerchantProductPriceHistory,
  type MerchantProductPricePoint,
  type PriceComparisonEligibility,
  type PriceComparisonRejectionReason,
  type PriceComparisonStrategy,
} from './productIdentityPriceComparison';

export type PriceComparisonShadowObservation = ShadowIdentityObservation & {
  occurredAt?: number | null;
  productFamilyKey?: string | null;
  volumeBaseMl?: number | null;
  weightBaseG?: number | null;
  countBase?: number | null;
  skuKey?: string | null;
};

export type PriceComparisonExample = {
  kind:
    | 'mp_history_success'
    | 'normalization'
    | 'rejected'
    | 'family_or_unit_reference';
  rawNames: string[];
  merchantKey: string;
  merchantProductId: string | null;
  dates: string[];
  prices: number[];
  strategy: PriceComparisonStrategy;
  note: string;
};

export type PriceJumpCase = {
  merchantProductId: string;
  merchantKey: string;
  rawNames: string[];
  observationCount: number;
  previous: number;
  latest: number;
  pctChange: number;
  dates: string[];
  prices: number[];
};

export type HighFrequencyMpAudit = {
  merchantProductId: string;
  merchantKey: string;
  observationCount: number;
  rawNames: string[];
  dates: string[];
  prices: number[];
  min: number;
  max: number;
  /** Human review flag — set when raw names look inconsistent. */
  suspiciousNameSpread: boolean;
  note: string;
};

export type PriceComparisonShadowAuditReport = {
  contractVersion: 'meruno-product-identity-price-comparison-shadow-v5a';
  comparisonVersion: typeof PRODUCT_IDENTITY_PRICE_COMPARISON_VERSION;
  geminiAdditionalCalls: 0;
  userVisibleBehaviorChange: false;
  priceSsot: {
    field: 'lineTotal / quantity';
    description: string;
    couponAllocation: 'not_allocated';
  };
  dataset: ShadowDatasetSummary;
  identityBaseline: {
    distinctMerchantProducts: number;
    merchantProductsWith2PlusObservations: number;
    merchantProductsWith3PlusObservations: number;
    productExact: number;
    skuExact: number;
  };
  strongestStrategyDistribution: Record<PriceComparisonStrategy, number>;
  capabilityCounts: Record<PriceComparisonStrategy, number>;
  unitNormalizationCoverage: Record<MeasurementDimension | 'none', number>;
  merchantProductHistory: {
    mpsWith2PlusPriceObs: number;
    mpsWith3PlusPriceObs: number;
    mpsWith5PlusPriceObs: number;
    priceObservationsParticipatingInMpHistory: number;
    identityAuditMpsWith2Plus: number;
    identityAuditMpsWith3Plus: number;
    gapExplanation: string[];
  };
  legacyVsNew: {
    legacyPurchaseUnitUsable: number;
    legacySkuHistoryUsable: number;
    legacyFamilyNormalizedUsable: number;
    newEligible: number;
    bothEligible: number;
    legacyOnly: number;
    newOnly: number;
    differenceNotes: string[];
  };
  unsupportedReasonDistribution: Record<string, number>;
  top10HighFrequencyMps: HighFrequencyMpAudit[];
  topPriceJumps: PriceJumpCase[];
  examples: PriceComparisonExample[];
  recommendationFor5B: string[];
};

function emptyStrategyCounts(): Record<PriceComparisonStrategy, number> {
  return {
    same_sku: 0,
    same_product: 0,
    same_merchant_product: 0,
    family_spec: 0,
    unit_price: 0,
    no_comparison: 0,
  };
}

function parseMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return String(ms);
  }
}

function nameSpreadSuspicious(names: string[]): boolean {
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (uniq.length <= 1) return false;
  // Very different lengths or shared stem under 40% of chars → flag for review.
  const stems = uniq.map((n) => n.replace(/\d+/g, '').replace(/\s+/g, '').slice(0, 8));
  const stemSet = new Set(stems);
  return stemSet.size >= 3 || uniq.length >= 5;
}

export function enrichObservationsForPriceShadow(
  observations: ShadowIdentityObservation[],
  payload: {
    receipts?: Array<Record<string, unknown>>;
    receiptItems?: Array<Record<string, unknown>>;
  }
): PriceComparisonShadowObservation[] {
  const occurredByReceipt = new Map<string, number>();
  for (const r of payload.receipts ?? []) {
    const id = String(r.id ?? '');
    if (!id) continue;
    const at =
      parseMs(r.transaction_at) ??
      parseMs(r.created_at) ??
      parseMs(r.scanned_at);
    if (at != null) occurredByReceipt.set(id, at);
  }

  const itemMeta = new Map<string, Record<string, unknown>>();
  for (const item of payload.receiptItems ?? []) {
    const rid = String(item.receipt_id ?? '');
    const idx = Number(item.source_index ?? item.review_source_index ?? 0);
    itemMeta.set(`${rid}#${idx}`, item);
  }

  return observations.map((o) => {
    const meta = itemMeta.get(`${o.receiptId}#${o.itemSourceIndex}`) ?? {};
    const sku =
      (meta.sku_key as string | null | undefined) ??
      (meta.skuKey as string | null | undefined) ??
      null;
    return {
      ...o,
      occurredAt: occurredByReceipt.get(o.receiptId) ?? null,
      productFamilyKey:
        (meta.product_family_key as string | null | undefined) ?? null,
      volumeBaseMl:
        typeof meta.volume_base_ml === 'number' ? meta.volume_base_ml : null,
      weightBaseG:
        typeof meta.weight_base_g === 'number'
          ? meta.weight_base_g
          : typeof meta.mass_base_g === 'number'
            ? meta.mass_base_g
            : null,
      countBase: typeof meta.count_base === 'number' ? meta.count_base : null,
      skuKey: sku && String(sku).trim() ? String(sku) : null,
    };
  });
}

export function runPriceComparisonShadowAudit(
  observations: PriceComparisonShadowObservation[],
  dataset: ShadowDatasetSummary,
  store: ProductIdentityStore = createMemoryProductIdentityStore()
): PriceComparisonShadowAuditReport {
  const strongestStrategyDistribution = emptyStrategyCounts();
  const capabilityCounts = emptyStrategyCounts();
  const unitNormalizationCoverage: Record<MeasurementDimension | 'none', number> = {
    mass: 0,
    volume: 0,
    count: 0,
    length: 0,
    roll_count: 0,
    none: 0,
  };
  const unsupportedReasonDistribution: Record<string, number> = {};

  let productExact = 0;
  let skuExact = 0;
  const obsCountByMp = new Map<string, number>();
  const pricePointsByMp = new Map<string, MerchantProductPricePoint[]>();
  const mpMerchant = new Map<string, string>();

  type Row = {
    obs: PriceComparisonShadowObservation;
    eligibility: PriceComparisonEligibility;
    merchantProductId: string | null;
    canonicalProductId: string | null;
    identityLevel: string;
    legacy: ReturnType<typeof evaluateLegacyPriceEligibility>;
  };
  const rows: Row[] = [];

  let legacyPurchaseUnitUsable = 0;
  let legacySkuHistoryUsable = 0;
  let legacyFamilyNormalizedUsable = 0;
  let newEligible = 0;
  let bothEligible = 0;
  let legacyOnly = 0;
  let newOnly = 0;

  for (const obs of observations) {
    const name = (obs.rawName || '').trim();
    const result = name
      ? resolveReceiptItemIdentity(
          {
            rawName: name,
            merchantKey: obs.merchantKey || 'unknown_merchant',
            receiptId: obs.receiptId,
            itemSourceIndex: obs.itemSourceIndex,
            quantity: obs.quantity,
            lineTotal: obs.lineTotal,
          },
          store
        )
      : null;

    const merchantProductId = result?.link.merchantProductId ?? null;
    const canonicalProductId = result?.link.canonicalProductId ?? null;
    const identityLevel = result?.link.identityLevel ?? 'unresolved';
    if (identityLevel === 'product_exact') productExact += 1;
    if (identityLevel === 'sku_exact') skuExact += 1;
    if (merchantProductId) {
      obsCountByMp.set(merchantProductId, (obsCountByMp.get(merchantProductId) ?? 0) + 1);
      mpMerchant.set(merchantProductId, obs.merchantKey);
    }

    const attrs =
      result?.attributes ?? normalizeProductForIdentity(name || ' ').attributes;

    const eligibility = evaluatePriceComparisonEligibility({
      rawName: name,
      merchantKey: obs.merchantKey,
      lineTotal: obs.lineTotal,
      quantity: obs.quantity,
      merchantProductId,
      canonicalProductId,
      skuId: null,
      identityLevel,
      attributes: attrs,
      productFamilyKey: obs.productFamilyKey,
    });

    strongestStrategyDistribution[eligibility.strongestStrategy] += 1;
    for (const c of eligibility.capabilities) {
      capabilityCounts[c] += 1;
    }
    if (eligibility.measurementDimension) {
      unitNormalizationCoverage[eligibility.measurementDimension] += 1;
    } else {
      unitNormalizationCoverage.none += 1;
    }
    for (const r of eligibility.rejectionReasons) {
      unsupportedReasonDistribution[r] =
        (unsupportedReasonDistribution[r] ?? 0) + 1;
    }

    const legacy = evaluateLegacyPriceEligibility({
      lineTotal: obs.lineTotal,
      quantity: obs.quantity,
      skuKey: obs.skuKey,
      productFamilyKey: obs.productFamilyKey,
      volumeBaseMl: obs.volumeBaseMl,
      weightBaseG: obs.weightBaseG,
      countBase: obs.countBase,
    });
    if (legacy.purchaseUnitUsable) legacyPurchaseUnitUsable += 1;
    if (legacy.skuHistoryUsable) legacySkuHistoryUsable += 1;
    if (legacy.familyNormalizedUsable) legacyFamilyNormalizedUsable += 1;

    // Dual-run: legacy purchase-unit usable (Analysis D) vs new comparison eligible
    if (legacy.purchaseUnitUsable) {
      if (eligibility.eligible) bothEligible += 1;
      else legacyOnly += 1;
    } else if (eligibility.eligible) {
      newOnly += 1;
    }
    if (eligibility.eligible) newEligible += 1;

    if (
      merchantProductId &&
      eligibility.purchaseUnitPrice != null &&
      eligibility.capabilities.includes('same_merchant_product') &&
      positiveOccurredAt(obs.occurredAt)
    ) {
      const point: MerchantProductPricePoint = {
        receiptId: obs.receiptId,
        itemSourceIndex: obs.itemSourceIndex,
        occurredAt: obs.occurredAt as number,
        rawName: name,
        merchantKey: obs.merchantKey,
        merchantProductId,
        lineTotal: obs.lineTotal as number,
        quantity: obs.quantity as number,
        purchaseUnitPrice: eligibility.purchaseUnitPrice,
        normalizedUnitPrice: eligibility.normalizedUnitPrice,
      };
      const list = pricePointsByMp.get(merchantProductId) ?? [];
      list.push(point);
      pricePointsByMp.set(merchantProductId, list);
    }

    rows.push({
      obs,
      eligibility,
      merchantProductId,
      canonicalProductId,
      identityLevel,
      legacy,
    });
  }

  const histories: MerchantProductPriceHistory[] = [];
  for (const [mpId, pts] of pricePointsByMp) {
    const h = buildMerchantProductPriceHistory(
      mpId,
      mpMerchant.get(mpId) ?? pts[0]?.merchantKey ?? '',
      pts
    );
    if (h) histories.push(h);
  }

  const mpsWith2 = [...obsCountByMp.values()].filter((n) => n >= 2).length;
  const mpsWith3 = [...obsCountByMp.values()].filter((n) => n >= 3).length;

  const priceObsCounts = [...pricePointsByMp.values()].map((p) => p.length);
  const mpsWith2PlusPriceObs = priceObsCounts.filter((n) => n >= 2).length;
  const mpsWith3PlusPriceObs = priceObsCounts.filter((n) => n >= 3).length;
  const mpsWith5PlusPriceObs = priceObsCounts.filter((n) => n >= 5).length;
  const priceObservationsParticipatingInMpHistory = [
    ...pricePointsByMp.values(),
  ]
    .filter((p) => p.length >= 2)
    .reduce((a, p) => a + p.length, 0);

  const gapExplanation: string[] = [];
  if (mpsWith2 !== mpsWith2PlusPriceObs) {
    gapExplanation.push(
      `Identity MPs with 2+ obs (${mpsWith2}) vs price-history MPs with 2+ (${mpsWith2PlusPriceObs}): gap often from missing occurredAt, invalid price/qty, or MP assigned without usable purchase unit.`
    );
  }
  if (mpsWith3 !== mpsWith3PlusPriceObs) {
    gapExplanation.push(
      `Identity MPs with 3+ (${mpsWith3}) vs price MPs with 3+ (${mpsWith3PlusPriceObs}).`
    );
  }
  if (!gapExplanation.length) {
    gapExplanation.push(
      'Identity reuse counts and price-history MP counts align closely on this dataset.'
    );
  }

  const top10HighFrequencyMps = [...pricePointsByMp.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([mpId, pts]) => {
      const sorted = [...pts].sort(
        (a, b) =>
          a.occurredAt - b.occurredAt ||
          a.receiptId.localeCompare(b.receiptId) ||
          a.itemSourceIndex - b.itemSourceIndex
      );
      const names = sorted.map((p) => p.rawName);
      const prices = sorted.map((p) => p.purchaseUnitPrice);
      const suspicious = nameSpreadSuspicious(names);
      return {
        merchantProductId: mpId,
        merchantKey: sorted[0]?.merchantKey ?? '',
        observationCount: sorted.length,
        rawNames: [...new Set(names)],
        dates: sorted.map((p) => formatDate(p.occurredAt)),
        prices,
        min: Math.min(...prices),
        max: Math.max(...prices),
        suspiciousNameSpread: suspicious,
        note: suspicious
          ? 'REVIEW: diverse raw names under one MP — check false merge'
          : 'names look consistent for merchant-local history',
      };
    });

  const topPriceJumps: PriceJumpCase[] = histories
    .filter(
      (h) =>
        h.points.length >= 3 &&
        h.latestVsPreviousPct != null &&
        Number.isFinite(h.latestVsPreviousPct)
    )
    .map((h) => ({
      merchantProductId: h.merchantProductId,
      merchantKey: h.merchantKey,
      rawNames: [...new Set(h.points.map((p) => p.rawName))],
      observationCount: h.points.length,
      previous: h.previous as number,
      latest: h.latest,
      pctChange: h.latestVsPreviousPct as number,
      dates: h.points.map((p) => formatDate(p.occurredAt)),
      prices: h.points.map((p) => p.purchaseUnitPrice),
    }))
    .sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange))
    .slice(0, 20);

  const examples = collectExamples(rows, histories);

  const recommendationFor5B = buildRecommendations({
    mpsWith2PlusPriceObs,
    mpsWith3PlusPriceObs,
    capabilityCounts,
    strongestStrategyDistribution,
    top10HighFrequencyMps,
  });

  return {
    contractVersion: 'meruno-product-identity-price-comparison-shadow-v5a',
    comparisonVersion: PRODUCT_IDENTITY_PRICE_COMPARISON_VERSION,
    geminiAdditionalCalls: 0,
    userVisibleBehaviorChange: false,
    priceSsot: {
      field: 'lineTotal / quantity',
      description:
        'Purchase unit paid price = lineTotal ÷ quantity. Prefer lineTotal (transaction truth) over OCR unitPrice. Receipt-level coupons: not allocated.',
      couponAllocation: 'not_allocated',
    },
    dataset,
    identityBaseline: {
      distinctMerchantProducts: obsCountByMp.size,
      merchantProductsWith2PlusObservations: mpsWith2,
      merchantProductsWith3PlusObservations: mpsWith3,
      productExact,
      skuExact,
    },
    strongestStrategyDistribution,
    capabilityCounts,
    unitNormalizationCoverage,
    merchantProductHistory: {
      mpsWith2PlusPriceObs,
      mpsWith3PlusPriceObs,
      mpsWith5PlusPriceObs,
      priceObservationsParticipatingInMpHistory,
      identityAuditMpsWith2Plus: mpsWith2,
      identityAuditMpsWith3Plus: mpsWith3,
      gapExplanation,
    },
    legacyVsNew: {
      legacyPurchaseUnitUsable,
      legacySkuHistoryUsable,
      legacyFamilyNormalizedUsable,
      newEligible,
      bothEligible,
      legacyOnly,
      newOnly,
      differenceNotes: [
        `Legacy purchaseUnit usable ≈ price value usable (Analysis D: ${legacyPurchaseUnitUsable}).`,
        `Legacy sku history usable=${legacySkuHistoryUsable}; familyNormalized=${legacyFamilyNormalizedUsable} (was ~0 / ~1).`,
        `New engine eligible=${newEligible} (any strategy beyond no_comparison).`,
        'Price value usable ≠ price history comparable: MP history needs same merchantProductId across ≥2 dated observations.',
        `both=${bothEligible} legacyOnly=${legacyOnly} newOnly=${newOnly} (purchase-unit vs new eligible).`,
      ],
    },
    unsupportedReasonDistribution,
    top10HighFrequencyMps,
    topPriceJumps,
    examples,
    recommendationFor5B,
  };
}

function positiveOccurredAt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function collectExamples(
  rows: Array<{
    obs: PriceComparisonShadowObservation;
    eligibility: PriceComparisonEligibility;
    merchantProductId: string | null;
  }>,
  histories: MerchantProductPriceHistory[]
): PriceComparisonExample[] {
  const out: PriceComparisonExample[] = [];

  const sortedHist = [...histories].sort(
    (a, b) => b.points.length - a.points.length
  );
  for (const h of sortedHist.slice(0, 8)) {
    out.push({
      kind: 'mp_history_success',
      rawNames: [...new Set(h.points.map((p) => p.rawName))],
      merchantKey: h.merchantKey,
      merchantProductId: h.merchantProductId,
      dates: h.points.map((p) => formatDate(p.occurredAt)),
      prices: h.points.map((p) => p.purchaseUnitPrice),
      strategy: 'same_merchant_product',
      note: `merchant-local history n=${h.points.length}; min=${h.min} max=${h.max} latest=${h.latest}`,
    });
  }

  for (const row of rows) {
    if (out.length >= 20) break;
    const n = row.eligibility.normalizedUnitPrice;
    if (!n) continue;
    if (n.dimension !== 'volume' && n.dimension !== 'mass') continue;
    out.push({
      kind: 'normalization',
      rawNames: [row.obs.rawName],
      merchantKey: row.obs.merchantKey,
      merchantProductId: row.merchantProductId,
      dates: [
        row.obs.occurredAt != null ? formatDate(row.obs.occurredAt) : 'unknown',
      ],
      prices: row.eligibility.purchaseUnitPrice
        ? [row.eligibility.purchaseUnitPrice]
        : [],
      strategy: row.eligibility.strongestStrategy,
      note: `${n.dimension} base=${n.unitPriceBase.toFixed(4)} ${n.unitLabel}; displayPer1000=${n.displayPer1000?.toFixed(2) ?? 'n/a'}`,
    });
  }

  for (const row of rows) {
    if (out.filter((e) => e.kind === 'rejected').length >= 4) break;
    if (row.eligibility.eligible) continue;
    if (!row.eligibility.rejectionReasons.length) continue;
    out.push({
      kind: 'rejected',
      rawNames: [row.obs.rawName],
      merchantKey: row.obs.merchantKey,
      merchantProductId: row.merchantProductId,
      dates: [
        row.obs.occurredAt != null ? formatDate(row.obs.occurredAt) : 'unknown',
      ],
      prices: [],
      strategy: 'no_comparison',
      note: `reasons=${row.eligibility.rejectionReasons.join(',')}`,
    });
  }

  for (const row of rows) {
    if (out.filter((e) => e.kind === 'family_or_unit_reference').length >= 4) {
      break;
    }
    const caps = row.eligibility.capabilities;
    if (
      !caps.includes('unit_price') &&
      !caps.includes('family_spec')
    ) {
      continue;
    }
    if (caps.includes('same_sku') || caps.includes('same_product')) continue;
    out.push({
      kind: 'family_or_unit_reference',
      rawNames: [row.obs.rawName],
      merchantKey: row.obs.merchantKey,
      merchantProductId: row.merchantProductId,
      dates: [
        row.obs.occurredAt != null ? formatDate(row.obs.occurredAt) : 'unknown',
      ],
      prices: row.eligibility.purchaseUnitPrice
        ? [row.eligibility.purchaseUnitPrice]
        : [],
      strategy: row.eligibility.strongestStrategy,
      note:
        'unit/family reference only — not exact same-product price history across merchants',
    });
  }

  // Ensure ≥20 by filling more MP histories / unit refs.
  for (const h of sortedHist.slice(8)) {
    if (out.length >= 20) break;
    out.push({
      kind: 'mp_history_success',
      rawNames: [...new Set(h.points.map((p) => p.rawName))],
      merchantKey: h.merchantKey,
      merchantProductId: h.merchantProductId,
      dates: h.points.map((p) => formatDate(p.occurredAt)),
      prices: h.points.map((p) => p.purchaseUnitPrice),
      strategy: 'same_merchant_product',
      note: `extra MP history n=${h.points.length}`,
    });
  }

  return out.slice(0, 24);
}

function buildRecommendations(args: {
  mpsWith2PlusPriceObs: number;
  mpsWith3PlusPriceObs: number;
  capabilityCounts: Record<PriceComparisonStrategy, number>;
  strongestStrategyDistribution: Record<PriceComparisonStrategy, number>;
  top10HighFrequencyMps: HighFrequencyMpAudit[];
}): string[] {
  const suspicious = args.top10HighFrequencyMps.filter(
    (m) => m.suspiciousNameSpread
  ).length;
  return [
    `same_merchant_product: SAFE enough for Batch 5B merchant-local price history when ≥2 dated observations (${args.mpsWith2PlusPriceObs} MPs). Presentation must say「この店舗でこの商品」.`,
    `Trend / 値上がり claims: require ≥3 observations (${args.mpsWith3PlusPriceObs} MPs) — still shadow-only until 5B UI copy is wired.`,
    `same_sku / same_product: not ready (counts remain 0 on real data). Do not invent cross-merchant exact history.`,
    `family_spec / unit_price: allow as weaker「参考」only; never as「この商品が値上がり」.`,
    `Top-10 MP name-spread flags: ${suspicious}/10 — review before wiring UI.`,
    'Keep legacy price path until 5B dual-consumes and presentation contract is enforced.',
  ];
}
