/**
 * Home value-hierarchy helpers (R2-B3).
 *
 * Presentation / navigation only. Does not recalculate Analysis merchants,
 * spend deltas, milestones, or product identity.
 */

import type { MilestoneFrequentProduct } from './engagementMilestones';
import type { ProgressiveHomeStage } from './homeProgressiveExperience';
import { buildProductDetailHref } from './productDetailTarget';

export type HomeValueSurfaceFlags = {
  showScanHero: true;
  showEmptyCopy: boolean;
  showLatestPurchase: boolean;
  showMilestoneProgress: boolean;
  showRecentInsight: boolean;
  showFrequentProducts: boolean;
  showProfile: boolean;
  /** Single Analysis entry — never for the empty Home. */
  showAnalysisCta: boolean;
};

/**
 * Which Home value surfaces are eligible for a progressive stage.
 * Matches ProgressiveHomeInsights gating (presentation contract).
 */
export function homeValueSurfaceFlags(
  stage: ProgressiveHomeStage
): HomeValueSurfaceFlags {
  return {
    showScanHero: true,
    showEmptyCopy: stage === 'empty',
    showLatestPurchase: stage !== 'empty',
    showMilestoneProgress: stage !== 'empty',
    showRecentInsight: stage === 'recent' || stage === 'frequent',
    showFrequentProducts: stage === 'frequent' || stage === 'profile',
    showProfile: stage === 'profile',
    showAnalysisCta: stage !== 'empty',
  };
}

/**
 * Home → Product Detail href using the existing aggregatable route contract.
 * Returns null for unresolved / incomplete identities (no invented fallback).
 */
export function buildHomeFrequentProductDetailHref(
  product: Pick<MilestoneFrequentProduct, 'groupingType' | 'key'>
): `/product/${'sku' | 'canonical' | 'family' | 'merchant_product'}?key=${string}` | null {
  const type = product.groupingType;
  if (
    type !== 'sku' &&
    type !== 'canonical' &&
    type !== 'family' &&
    type !== 'merchant_product'
  ) {
    return null;
  }
  const key = typeof product.key === 'string' ? product.key.trim() : '';
  if (!key) return null;
  return buildProductDetailHref({ type, key });
}

/** Existing Analysis tab route — do not invent a parallel Analysis stack. */
export const HOME_ANALYSIS_HREF = '/analysis' as const;
