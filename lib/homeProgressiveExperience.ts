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
  buildHomeRepeatFrequentProducts,
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

function buildHomeLongTermFrequentProducts(
  analyticsReceipts: ReceiptRow[],
  productRows: readonly EngagementProductRow[],
  personalInventory: PersonalProductEndpointInventory | null = null
): MilestoneFrequentProduct[] {
  return buildHomeRepeatFrequentProducts(
    analyticsReceipts,
    productRows,
    personalInventory
  );
}

/**
 * @param receipts Already analytics-selected purchase candidates (Home passes
 *   selectAnalyticsReceipts(...).analyticsReceipts).
 * @param productRows Analytics-filtered engagement product rows (optional).
 *   When omitted / empty and stage is unlocked, frequent list is empty rather
 *   than falling back to milestone recent-window frequentProducts.
 * @param personalInventory Owner-scoped G4-2A inventory for Home personal
 *   frequent overlay (optional). When null, identity Home grouping is unchanged.
 */
export function buildHomeProgressiveExperience(
  receipts: ReceiptRow[],
  evaluation: CurrentEngagementMilestoneEvaluation | null,
  analyticsUnavailable = false,
  productRows: readonly EngagementProductRow[] = [],
  personalInventory: PersonalProductEndpointInventory | null = null
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
  const frequentProducts = frequentUnlocked
    ? buildHomeLongTermFrequentProducts(
        receipts,
        productRows,
        personalInventory
      )
    : [];
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
    frequentProducts,
    profile,
    dataCoverageIncomplete,
    analyticsUnavailable,
  };
}
