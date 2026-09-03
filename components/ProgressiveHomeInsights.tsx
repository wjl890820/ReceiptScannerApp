import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { HomeFrequentProductList } from '@/components/home/HomeFrequentProductList';
import { HomeNextPurchaseList } from '@/components/home/HomeNextPurchaseList';
import { HomeScanAction } from '@/components/home/HomeScanAction';
import { MerchantIdentityTile } from '@/components/MerchantIdentityTile';
import { MerunoDisclosureIndicator } from '@/components/MerunoDisclosureIndicator';
import {
  MerunoGroupedList,
  MerunoGroupedRow,
} from '@/components/MerunoGroupedList';
import { MerunoText } from '@/components/primitives/MerunoText';
import { SectionTitle } from '@/components/SectionTitle';
import { getCategoryLabel } from '@/lib/categoryPalette';
import type { MilestoneFrequentProduct } from '@/lib/engagementMilestones';
import { formatDate } from '@/lib/formatDate';
import { formatJPY } from '@/lib/formatJPY';
import type { HomeProgressiveExperience } from '@/lib/homeProgressiveExperience';
import { t } from '@/lib/i18n';
import {
  formatMilestoneRecentChange,
  formatMilestoneSummary,
} from '@/lib/milestonePresentation';
import type { NextPurchaseCandidate } from '@/lib/nextPurchaseCandidates';
import type { ProductCategory } from '@/lib/productCategory';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
  UI_SPACING,
} from '@/lib/uiTokens';

import { MilestoneProgressCard } from './MilestoneProgressCard';

type ProgressiveHomeInsightsProps = {
  experience: HomeProgressiveExperience;
  initialLoading: boolean;
  scanning: boolean;
  processingProgress: { current: number; total: number } | null;
  onScan: () => void;
  onRecentPurchasePress: (receiptId: string) => void;
  onProductPress: (product: MilestoneFrequentProduct) => void;
  onNextPurchasePress?: (candidate: NextPurchaseCandidate) => void;
};

function categoryLabel(category: string): string {
  return getCategoryLabel(category as ProductCategory);
}

function formatAmount(amount: number, currency: string): string {
  return currency === 'JPY'
    ? formatJPY(amount)
    : `${currency} ${amount.toLocaleString()}`;
}

export function ProgressiveHomeInsights({
  experience,
  initialLoading,
  scanning,
  processingProgress,
  onScan,
  onRecentPurchasePress,
  onProductPress,
  onNextPurchasePress,
}: ProgressiveHomeInsightsProps) {
  const showRecent =
    experience.stage !== 'empty' && experience.latestPurchase != null;
  const showMilestoneProgress =
    showRecent && experience.status.nextMilestone != null;
  const showRecentInsight =
    (experience.stage === 'recent' || experience.stage === 'frequent') &&
    experience.recentInsight != null;
  const showFrequentSection =
    experience.stage === 'frequent' ||
    (experience.stage === 'profile' && experience.frequentProducts.length > 0);
  // Same unlock boundary as Frequent Products; may show empty neutral state.
  const showNextPurchaseSection =
    experience.stage === 'frequent' || experience.stage === 'profile';

  return (
    <>
      <MerunoText role="pageTitle" tone="primary">
        {t('home.progressive.title')}
      </MerunoText>
      <MerunoText role="bodySmall" tone="secondary" style={styles.pageSubtitle}>
        {t('home.progressive.subtitle')}
      </MerunoText>

      <HomeScanAction
        scanning={scanning}
        processingProgress={processingProgress}
        onScan={onScan}
      />

      {experience.stage === 'empty' && !initialLoading && (
        <View style={styles.emptyValue}>
          <MerunoText role="bodySmall" tone="primary" style={styles.emptyTitle}>
            {t('home.progressive.empty.title')}
          </MerunoText>
          <MerunoText role="meta" tone="secondary" style={styles.emptySubtitle}>
            {t('home.progressive.empty.subtitle')}
          </MerunoText>
        </View>
      )}

      {showRecent && experience.latestPurchase && (
        <>
          <SectionTitle title={t('home.progressive.recent.title')} />
          <MerunoGroupedList>
            <MerunoGroupedRow
              onPress={() =>
                onRecentPurchasePress(experience.latestPurchase!.receiptId)
              }
              accessibilityRole="button"
              accessibilityLabel={t('home.progressive.recent.openA11y')}
              showDivider={false}
              minHeight={76}
              dividerInset={0}
              style={styles.recentRow}
            >
              {({ pressed }) => (
                <View style={styles.recentRowInner}>
                  <MerchantIdentityTile
                    merchant={experience.latestPurchase!.merchant}
                    size={38}
                  />
                  <View style={styles.recentText}>
                    <MerunoText
                      role="bodySmall"
                      tone="primary"
                      style={styles.merchantName}
                      numberOfLines={2}
                    >
                      {experience.latestPurchase!.merchant ||
                        t('common.unknownMerchant')}
                    </MerunoText>
                    <MerunoText role="caption" tone="muted" style={styles.recentMeta}>
                      {experience.latestPurchase!.transactionAt != null
                        ? formatDate(experience.latestPurchase!.transactionAt)
                        : t('history.detail.dateUnknown')}
                      {' · '}
                      {t('home.progressive.recent.items', {
                        count: experience.latestPurchase!.itemCount,
                      })}
                    </MerunoText>
                  </View>
                  <MerunoText
                    role="amount"
                    tone="primary"
                    style={styles.recentAmount}
                  >
                    {formatAmount(
                      experience.latestPurchase!.total,
                      experience.latestPurchase!.currency
                    )}
                  </MerunoText>
                  <MerunoDisclosureIndicator
                    kind="crossEntity"
                    pressed={pressed}
                  />
                </View>
              )}
            </MerunoGroupedRow>
          </MerunoGroupedList>
        </>
      )}

      {showMilestoneProgress ? (
        <View style={styles.milestoneProgressWrap}>
          <MilestoneProgressCard status={experience.status} />
        </View>
      ) : null}

      {initialLoading ? (
        <View style={styles.analyticsLoading}>
          <ActivityIndicator size="small" color={UI_COLORS.accent} />
        </View>
      ) : null}

      {experience.stage === 'profile' && experience.profile ? (
        <>
          <SectionTitle title={t('home.progressive.profile.title')} />
          <View style={styles.profileBlock}>
            {experience.profile.shoppingFrequency ? (
              <View>
                <MerunoText role="meta" tone="secondary">
                  {t('home.progressive.profile.frequencyLabel')}
                </MerunoText>
                <MerunoText
                  role="metric"
                  tone="primary"
                  style={styles.profileMetricValue}
                >
                  {t('home.progressive.profile.frequencyValue', {
                    days: Number(
                      experience.profile.shoppingFrequency.averageIntervalDays.toFixed(
                        1
                      )
                    ),
                  })}
                </MerunoText>
              </View>
            ) : null}
            {experience.profile.recentChange ? (
              <View
                style={
                  experience.profile.shoppingFrequency
                    ? styles.profileChangeSection
                    : undefined
                }
              >
                <MerunoText role="meta" tone="secondary">
                  {t('home.progressive.profile.recentChangeLabel')}
                </MerunoText>
                <MerunoText
                  role="bodySmall"
                  tone="secondary"
                  style={styles.profileChangeNarrative}
                >
                  {formatMilestoneRecentChange(
                    experience.profile.recentChange,
                    t,
                    categoryLabel
                  )}
                </MerunoText>
              </View>
            ) : null}
          </View>
        </>
      ) : null}

      {showRecentInsight && experience.recentInsight ? (
        <>
          <SectionTitle title={t('home.progressive.insight.title')} />
          <View style={styles.insightBlock}>
            <View style={styles.metricStrip}>
              <View style={styles.stripMetric}>
                <MerunoText role="caption" tone="muted">
                  {t('home.progressive.insight.total')}
                </MerunoText>
                <MerunoText role="amount" tone="primary" style={styles.stripValue}>
                  {formatJPY(experience.recentInsight.totalSpend)}
                </MerunoText>
              </View>
              <View style={[styles.stripMetric, styles.stripMetricBorder]}>
                <MerunoText role="caption" tone="muted">
                  {t('home.progressive.insight.average')}
                </MerunoText>
                <MerunoText role="amount" tone="primary" style={styles.stripValue}>
                  {formatJPY(experience.recentInsight.averageSpendPerReceipt)}
                </MerunoText>
              </View>
            </View>
            <MerunoText role="bodySmall" tone="primary" style={styles.insightSummary}>
              {formatMilestoneSummary(
                experience.recentInsight.summary,
                t,
                categoryLabel
              )}
            </MerunoText>
          </View>
        </>
      ) : null}

      {showNextPurchaseSection ? (
        <>
          <SectionTitle title={t('home.progressive.nextPurchase.title')} />
          {experience.nextPurchaseCandidates.length > 0 ? (
            <HomeNextPurchaseList
              candidates={experience.nextPurchaseCandidates}
              onPress={onNextPurchasePress}
            />
          ) : (
            <MerunoText role="meta" tone="secondary" style={styles.fallbackText}>
              {t('home.progressive.nextPurchase.empty')}
            </MerunoText>
          )}
        </>
      ) : null}

      {showFrequentSection ? (
        <>
          <SectionTitle title={t('home.progressive.frequent.title')} />
          {experience.frequentProducts.length > 0 ? (
            <HomeFrequentProductList
              products={experience.frequentProducts}
              onPress={onProductPress}
            />
          ) : (
            <MerunoText role="meta" tone="secondary" style={styles.fallbackText}>
              {t('home.progressive.frequent.preparing')}
            </MerunoText>
          )}
        </>
      ) : null}

      {experience.analyticsUnavailable && experience.stage !== 'empty' ? (
        <MerunoText role="caption" tone="muted" style={styles.analyticsFallback}>
          {t('home.progressive.analyticsUnavailable')}
        </MerunoText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  pageSubtitle: {
    marginTop: 5,
  },
  emptyValue: {
    marginTop: UI_SPACING.lg,
    paddingHorizontal: UI_SPACING.xs,
  },
  emptyTitle: {
    fontWeight: '700',
  },
  emptySubtitle: {
    marginTop: 5,
  },
  recentRow: {
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  recentRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: 15,
    gap: UI_SPACING.md,
  },
  recentText: {
    flex: 1,
    minWidth: 0,
  },
  merchantName: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '800',
  },
  recentMeta: {
    marginTop: 5,
  },
  recentAmount: {
    flexShrink: 0,
    marginRight: UI_SPACING.xs,
  },
  milestoneProgressWrap: {
    marginTop: UI_SPACING.lg,
  },
  analyticsLoading: {
    paddingVertical: UI_SPACING.xl,
    alignItems: 'center',
  },
  profileBlock: {
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: UI_SPACING.lg,
  },
  profileMetricValue: {
    marginTop: UI_SPACING.xs,
  },
  profileChangeSection: {
    marginTop: UI_SPACING.md,
    paddingTop: UI_SPACING.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
  },
  profileChangeNarrative: {
    marginTop: UI_SPACING.xs,
  },
  insightBlock: {
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    overflow: 'hidden',
  },
  metricStrip: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.borderSubtle,
  },
  stripMetric: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: UI_SPACING.lg,
  },
  stripMetricBorder: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: UI_COLORS.borderSubtle,
  },
  stripValue: {
    marginTop: 6,
    fontWeight: '800',
  },
  insightSummary: {
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: UI_SPACING.md,
    lineHeight: 21,
    fontWeight: '600',
  },
  fallbackText: {
    paddingVertical: UI_SPACING.sm,
    lineHeight: 19,
  },
  analyticsFallback: {
    marginTop: UI_LAYOUT.sectionGap,
    textAlign: 'center',
  },
});
