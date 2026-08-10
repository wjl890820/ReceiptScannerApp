import type {
  EngagementMilestone,
  EngagementMilestoneStatus,
  MilestoneDeterministicSummary,
  MilestoneFrequentProduct,
  MilestoneRecentChange,
} from './engagementMilestones';

export type MilestoneTranslate = (
  key: string,
  params?: Record<string, string | number>
) => string;

export type MilestoneCategoryLabel = (category: string) => string;

export type PostSaveMilestoneViewModel = {
  showProgress: boolean;
  supportedReceiptCount: number | null;
  unlockedMilestone: EngagementMilestone | null;
  nextMilestone: EngagementMilestone | null;
  receiptsUntilNext: number | null;
  profileEstablished: boolean;
};

export function buildPostSaveMilestoneViewModel(
  isSupportedReceipt: boolean,
  status: EngagementMilestoneStatus | null
): PostSaveMilestoneViewModel {
  if (!isSupportedReceipt || !status) {
    return {
      showProgress: false,
      supportedReceiptCount: null,
      unlockedMilestone: null,
      nextMilestone: null,
      receiptsUntilNext: null,
      profileEstablished: false,
    };
  }
  return {
    showProgress: true,
    supportedReceiptCount: status.supportedReceiptCount,
    unlockedMilestone: status.justUnlocked,
    nextMilestone: status.nextMilestone,
    receiptsUntilNext: status.receiptsUntilNext,
    profileEstablished: status.nextMilestone == null,
  };
}

export function formatMilestoneSummary(
  summary: MilestoneDeterministicSummary,
  translate: MilestoneTranslate,
  categoryLabel: MilestoneCategoryLabel
): string {
  const category =
    typeof summary.data.category === 'string'
      ? categoryLabel(summary.data.category)
      : '';
  const share =
    typeof summary.data.share === 'number'
      ? Math.round(summary.data.share * 100)
      : 0;
  return translate(summary.summaryKey, {
    ...summary.data,
    category,
    percentage: share,
  });
}

export function formatMilestoneRecentChange(
  change: MilestoneRecentChange,
  translate: MilestoneTranslate,
  categoryLabel: MilestoneCategoryLabel
): string {
  return translate(change.summaryKey, {
    category: categoryLabel(change.category),
    difference: Math.round(change.differencePercentagePoints),
  });
}

export function formatFrequentProductLabel(
  product: MilestoneFrequentProduct,
  translate: MilestoneTranslate
): string {
  return product.displayLabelKey
    ? translate(product.displayLabelKey)
    : product.displayLabel;
}
