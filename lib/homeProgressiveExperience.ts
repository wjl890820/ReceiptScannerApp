import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';
import {
  buildReceiptShoppingSummary,
  buildThreeReceiptMilestone,
  countSupportedReceipts,
  getEngagementMilestoneStatus,
  type CurrentEngagementMilestoneEvaluation,
  type EngagementMilestoneStatus,
  type MilestoneFrequentProduct,
  type ReceiptShoppingSummary,
  receiptOrderingTimestamp,
  type TenReceiptMilestone,
  type ThreeReceiptMilestone,
} from './engagementMilestones';
import {
  buildNextPurchaseCandidates,
  type NextPurchaseCandidate,
} from './nextPurchaseCandidates';
import {
  buildRepeatProductProfiles,
  mapRepeatProductProfileToHomeFrequentProduct,
  takeHomeRepeatProducts,
} from './repeatProductProfile';
import { filterV1SupportedReceipts } from './merchantType';
import type { PersonalProductEndpointInventory } from './personalProductEndpointInventory';

export type ProgressiveHomeStage =
  | 'empty'
  | 'first'
  | 'building'
  | 'recent'
  | 'frequent'
  | 'profile';

export type HomeProgressiveExperience = {
  stage: ProgressiveHomeStage;
  status: EngagementMilestoneStatus;
  latestPurchase: ReceiptShoppingSummary | null;
  recentInsight: ThreeReceiptMilestone | null;
  /**
   * Home「常购商品」— Repeat V1 SSOT (merchant_product | personal_product only).
   * purchaseOccurrenceCount = distinct canonical receipt IDs.
   * Milestone recent-window frequentProducts remain on milestone results only.
   */
  frequentProducts: MilestoneFrequentProduct[];
  /**
   * Next Purchase V0 — derived from uncapped Repeat profiles (not Home cap=5).
   * Empty until frequent stage unlock; may stay empty when no safe cadence.
   */
  nextPurchaseCandidates: NextPurchaseCandidate[];
  profile: TenReceiptMilestone | null;
  dataCoverageIncomplete: boolean;
  analyticsUnavailable: boolean;
};

export function resolveProgressiveHomeStage(
  supportedReceiptCount: number
): ProgressiveHomeStage {
  if (supportedReceiptCount <= 0) return 'empty';
  if (supportedReceiptCount === 1) return 'first';
  if (supportedReceiptCount === 2) return 'building';
  if (supportedReceiptCount < 5) return 'recent';
  if (supportedReceiptCount < 10) return 'frequent';
  return 'profile';
}

function receiptTimestamp(receipt: ReceiptRow): number {
  return receiptOrderingTimestamp(receipt);
}

export function filterHomeIdentityProductRows<
  T extends Pick<EngagementProductRow, 'receiptId'>,
>(
  productRows: readonly T[],
  supportedReceiptIds: ReadonlySet<string>
): T[] {
  return productRows.filter((row) => supportedReceiptIds.has(row.receiptId));
}

function buildHomeRepeatSurfaces(args: {
  analyticsReceipts: ReceiptRow[];
  productRows: readonly EngagementProductRow[];
  personalInventory: PersonalProductEndpointInventory | null;
  now: number;
}): {
  frequentProducts: MilestoneFrequentProduct[];
  nextPurchaseCandidates: NextPurchaseCandidate[];
} {
  try {
    const { isProductIdentityPriceHistoryV1Enabled } =
      require('./env') as typeof import('./env');
    if (!isProductIdentityPriceHistoryV1Enabled()) {
      return { frequentProducts: [], nextPurchaseCandidates: [] };
    }
  } catch {
    return { frequentProducts: [], nextPurchaseCandidates: [] };
  }

  try {
    // Uncapped Repeat SSOT — Home frequent cap must NOT truncate Next Purchase input.
    const allProfiles = buildRepeatProductProfiles(
      args.analyticsReceipts,
      args.productRows,
      { personalInventory: args.personalInventory }
    );
    return {
      frequentProducts: takeHomeRepeatProducts(allProfiles).map(
        mapRepeatProductProfileToHomeFrequentProduct
      ),
      nextPurchaseCandidates: buildNextPurchaseCandidates(allProfiles, {
        now: args.now,
      }),
    };
  } catch {
    return { frequentProducts: [], nextPurchaseCandidates: [] };
  }
}

/**
 * @param receipts Already analytics-selected purchase candidates (Home passes
 *   selectAnalyticsReceipts(...).analyticsReceipts).
 * @param productRows Analytics-filtered engagement product rows (optional).
 *   When omitted / empty and stage is unlocked, frequent list is empty rather
 *   than falling back to milestone recent-window frequentProducts.
 * @param personalInventory Owner-scoped G4-2A inventory for Home personal
 *   frequent overlay (optional). When null, identity Home grouping is unchanged.
 * @param now Reference timestamp for Next Purchase V0 (injected once per build).
 */
export function buildHomeProgressiveExperience(
  receipts: ReceiptRow[],
  evaluation: CurrentEngagementMilestoneEvaluation | null,
  analyticsUnavailable = false,
  productRows: readonly EngagementProductRow[] = [],
  personalInventory: PersonalProductEndpointInventory | null = null,
  now: number = 0
): HomeProgressiveExperience {
  const supportedReceipts = filterV1SupportedReceipts(receipts);
  const localCount = countSupportedReceipts(receipts);
  const status =
    evaluation?.status ?? getEngagementMilestoneStatus(localCount);
  const stage = resolveProgressiveHomeStage(status.supportedReceiptCount);
  const latestReceipt = [...supportedReceipts].sort(
    (left, right) =>
      receiptTimestamp(right) - receiptTimestamp(left) ||
      right.id.localeCompare(left.id)
  )[0];
  const latestPurchase = latestReceipt
    ? buildReceiptShoppingSummary(latestReceipt)
    : null;
  const recentInsight =
    status.supportedReceiptCount >= 3
      ? buildThreeReceiptMilestone(supportedReceipts)
      : null;
  const currentResult = evaluation?.currentResult ?? null;
  // Stage gate unchanged (frequent | profile). Data source = long-term SSOT.
  const frequentUnlocked = stage === 'frequent' || stage === 'profile';
  const referenceNow =
    typeof now === 'number' && Number.isFinite(now) && now > 0 ? now : 0;
  const repeatSurfaces = frequentUnlocked
    ? buildHomeRepeatSurfaces({
        analyticsReceipts: receipts,
        productRows,
        personalInventory,
        now: referenceNow,
      })
    : { frequentProducts: [], nextPurchaseCandidates: [] };
  const profile =
    currentResult?.milestone === 10 ? currentResult : null;
  const dataCoverageIncomplete =
    currentResult?.milestone === 5 || currentResult?.milestone === 10
      ? currentResult.dataCoverageIncomplete
      : false;

  return {
    stage,
    status,
    latestPurchase,
    recentInsight,
    frequentProducts: repeatSurfaces.frequentProducts,
    nextPurchaseCandidates: repeatSurfaces.nextPurchaseCandidates,
    profile,
    dataCoverageIncomplete,
    analyticsUnavailable,
  };
}
