/**
 * Product Identity Batch 5B — presentation contract for price / frequent UI.
 * UI must not invent stronger wording than the strategy allows.
 */

import type { PriceComparisonStrategy } from './productIdentityPriceComparison';
// PriceComparisonStrategy: same_sku | same_product | same_merchant_product | ...

export type PricePresentationCopy = {
  strategy: PriceComparisonStrategy;
  /** i18n key under priceHistory.* */
  titleKey: string;
  subtitleKey: string;
  /** Dev / audit only */
  strength: 'strongest' | 'strong' | 'merchant_local' | 'reference' | 'none';
  allowsTrendInsight: boolean;
  allowsCrossMerchantClaim: boolean;
};

const COPY: Record<PriceComparisonStrategy, PricePresentationCopy> = {
  same_sku: {
    strategy: 'same_sku',
    titleKey: 'priceHistory.titleMerchantLocal',
    subtitleKey: 'priceHistory.subtitle.sku',
    strength: 'strongest',
    allowsTrendInsight: true,
    allowsCrossMerchantClaim: true,
  },
  same_product: {
    strategy: 'same_product',
    titleKey: 'priceHistory.title',
    subtitleKey: 'priceHistory.subtitle.canonical',
    strength: 'strong',
    allowsTrendInsight: true,
    allowsCrossMerchantClaim: true,
  },
  same_merchant_product: {
    strategy: 'same_merchant_product',
    titleKey: 'priceHistory.titleMerchantLocal',
    subtitleKey: 'priceHistory.subtitle.merchantProduct',
    strength: 'merchant_local',
    allowsTrendInsight: true,
    allowsCrossMerchantClaim: false,
  },
  family_spec: {
    strategy: 'family_spec',
    titleKey: 'priceHistory.title',
    subtitleKey: 'priceHistory.subtitle.familySpecReference',
    strength: 'reference',
    allowsTrendInsight: false,
    allowsCrossMerchantClaim: false,
  },
  unit_price: {
    strategy: 'unit_price',
    titleKey: 'priceHistory.title',
    subtitleKey: 'priceHistory.subtitle.unitPriceReference',
    strength: 'reference',
    allowsTrendInsight: false,
    allowsCrossMerchantClaim: false,
  },
  no_comparison: {
    strategy: 'no_comparison',
    titleKey: 'priceHistory.title',
    subtitleKey: 'priceHistory.status.notEnough',
    strength: 'none',
    allowsTrendInsight: false,
    allowsCrossMerchantClaim: false,
  },
};

export function resolvePricePresentation(
  strategy: PriceComparisonStrategy
): PricePresentationCopy {
  return COPY[strategy] ?? COPY.no_comparison;
}

/** Stable display-name fallback for MerchantProduct consumers. */
export function resolveMerchantProductDisplayName(input: {
  semanticCanonicalName?: string | null;
  canonicalDisplayName?: string | null;
  normalizedName?: string | null;
  bestObservedRawName?: string | null;
}): string {
  const candidates = [
    input.semanticCanonicalName,
    input.canonicalDisplayName,
    input.normalizedName,
    input.bestObservedRawName,
  ];
  for (const c of candidates) {
    const t = typeof c === 'string' ? c.trim() : '';
    if (t) return t;
  }
  return 'product';
}
