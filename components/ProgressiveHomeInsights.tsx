import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { CategoryDonut } from '@/components/CategoryDonut';
import { MerchantIdentityTile } from '@/components/MerchantIdentityTile';
import { SectionTitle } from '@/components/SectionTitle';
import { getCategoryLabel } from '@/lib/categoryPalette';
import type {
  MilestoneCategoryComposition,
  MilestoneFrequentProduct,
} from '@/lib/engagementMilestones';
import { formatDate } from '@/lib/formatDate';
import { formatJPY } from '@/lib/formatJPY';
import type { HomeProgressiveExperience } from '@/lib/homeProgressiveExperience';
import { t } from '@/lib/i18n';
import {
  formatFrequentProductLabel,
  formatMilestoneRecentChange,
  formatMilestoneSummary,
} from '@/lib/milestonePresentation';
import { EDITORIAL_UI, UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

import { MilestoneProgressCard } from './MilestoneProgressCard';

type ProgressiveHomeInsightsProps = {
  experience: HomeProgressiveExperience;
  loading: boolean;
  scanning: boolean;
  processingProgress: { current: number; total: number } | null;
  onScan: () => void;
  onRecentPurchasePress: (receiptId: string) => void;
  onProductPress: (product: MilestoneFrequentProduct) => void;
};

function categoryLabel(category: string): string {
  return getCategoryLabel(category);
}

function formatAmount(amount: number, currency: string): string {
  return currency === 'JPY'
    ? formatJPY(amount)
    : `${currency} ${amount.toLocaleString()}`;
}

function FrequentProductList({
  products,
  onPress,
}: {
  products: MilestoneFrequentProduct[];
  onPress: (product: MilestoneFrequentProduct) => void;
}) {
  return (
    <View style={styles.panel}>
      {products.map((product, index) => {
        const label = formatFrequentProductLabel(product, t);
        return (
          <Pressable
            key={`${product.groupingType}:${product.key}`}
            onPress={() => onPress(product)}
            accessibilityRole="button"
            accessibilityLabel={t('home.progressive.frequent.openHistoryA11y', {
              name: label,
            })}
            style={({ pressed }) => [
              styles.productRow,
              index > 0 && styles.borderTop,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.productIconTile} importantForAccessibility="no">
              <MaterialIcons
                name="inventory-2"
                size={17}
                color={UI_COLORS.textSecondary}
              />
            </View>
            <View style={styles.productText}>
              <Text style={styles.productName} numberOfLines={2}>
                {label}
              </Text>
              <Text style={styles.productMeta}>
                {t('home.progressive.frequent.occurrences', {
                  count: product.purchaseOccurrenceCount,
                })}
                {product.totalPurchaseQuantity > 0
                  ? ` · ${t('home.progressive.frequent.quantity', {
                      count: product.totalPurchaseQuantity,
                    })}`
                  : ''}
              </Text>
            </View>
            <Text style={styles.chevron} importantForAccessibility="no">
              ›
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProfileComposition({
  categories,
}: {
  categories: MilestoneCategoryComposition[];
}) {
  const visible = categories.filter(
    (category) => category.itemCount > 0 || category.spend > 0
  );
  const shares = visible.map((category) => ({
    category,
    share: category.spend > 0 ? category.spendShare : category.itemShare,
  }));
  return (
    <View style={styles.profileComposition}>
      <CategoryDonut
        entries={shares.map((entry) => ({
          category: entry.category.category,
          share: entry.share,
        }))}
      />
    </View>
  );
}

export function ProgressiveHomeInsights({
  experience,
  loading,
  scanning,
  processingProgress,
  onScan,
  onRecentPurchasePress,
  onProductPress,
}: ProgressiveHomeInsightsProps) {
  const scanLabel = processingProgress
    ? t('home.scan.processingMulti', {
        current: processingProgress.current,
        total: processingProgress.total,
      })
    : scanning
      ? t('home.scan.processing')
      : t('home.scan.button');
  const showRecent =
    experience.stage !== 'empty' && experience.latestPurchase != null;
  const showRecentInsight =
    (experience.stage === 'recent' || experience.stage === 'frequent') &&
    experience.recentInsight != null;

  return (
    <>
      <Text style={styles.pageTitle}>{t('home.progressive.title')}</Text>
      <Text style={styles.pageSubtitle}>
        {t('home.progressive.subtitle')}
      </Text>

      <Pressable
        onPress={onScan}
        disabled={scanning}
        accessibilityRole="button"
        accessibilityLabel={scanLabel}
        style={({ pressed }) => [
          styles.scanHero,
          scanning && styles.disabled,
          pressed && styles.scanHeroPressed,
        ]}
      >
        <View style={styles.scanIconTile} importantForAccessibility="no">
          {scanning && !processingProgress ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <MaterialIcons name="document-scanner" size={30} color="#FFFFFF" />
          )}
        </View>
        <View style={styles.scanCopy}>
          <Text style={styles.scanTitle}>{t('home.progressive.scan.title')}</Text>
          <Text style={styles.scanSubtitle}>
            {t('home.progressive.scan.subtitle')}
          </Text>
          <Text style={styles.scanSupport}>
            {t('home.progressive.scan.support')}
          </Text>
        </View>
        <View style={styles.scanActionRow}>
          <Text style={styles.scanActionLabel}>{scanLabel}</Text>
          {!scanning ? (
            <MaterialIcons name="arrow-forward" size={18} color="#FFFFFF" />
          ) : null}
        </View>
        <View style={styles.scanCornerDetail} />
      </Pressable>

      {experience.stage === 'empty' && (
        <View style={styles.emptyValue}>
          <Text style={styles.emptyTitle}>
            {t('home.progressive.empty.title')}
          </Text>
          <Text style={styles.emptySubtitle}>
            {t('home.progressive.empty.subtitle')}
          </Text>
        </View>
      )}

      {showRecent && experience.latestPurchase && (
        <>
          <SectionTitle title={t('home.progressive.recent.title')} />
          <Pressable
            onPress={() =>
              onRecentPurchasePress(experience.latestPurchase!.receiptId)
            }
            accessibilityRole="button"
            accessibilityLabel={t('home.progressive.recent.openA11y')}
            style={({ pressed }) => [
              styles.panel,
              styles.recentCard,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.recentTop}>
              <MerchantIdentityTile
                merchant={experience.latestPurchase.merchant}
                size={38}
              />
              <View style={styles.recentText}>
                <Text style={styles.merchant} numberOfLines={2}>
                  {experience.latestPurchase.merchant ||
                    t('common.unknownMerchant')}
                </Text>
                <Text style={styles.recentMeta}>
                  {formatDate(experience.latestPurchase.transactionAt)}
                  {' · '}
                  {t('home.progressive.recent.items', {
                    count: experience.latestPurchase.itemCount,
                  })}
                </Text>
              </View>
              <Text style={styles.recentAmount}>
                {formatAmount(
                  experience.latestPurchase.total,
                  experience.latestPurchase.currency
                )}
              </Text>
              <Text style={styles.chevron} importantForAccessibility="no">
                ›
              </Text>
            </View>
          </Pressable>

          {/* Mature users: hide permanent "profile established" progress block. */}
          {experience.status.nextMilestone != null ? (
            <>
              <SectionTitle title={t('home.progressive.progress.section')} />
              <MilestoneProgressCard status={experience.status} />
            </>
          ) : null}
        </>
      )}

      {loading && experience.stage !== 'empty' && (
        <View style={styles.analyticsLoading}>
          <ActivityIndicator size="small" color="#1677ff" />
        </View>
      )}

      {showRecentInsight && experience.recentInsight && (
        <>
          <SectionTitle title={t('home.progressive.insight.title')} />
          <View style={[styles.panel, styles.profilePanel]}>
            <View style={styles.metricRow}>
              <View style={styles.metric}>
                <Text style={styles.metricLabel}>
                  {t('home.progressive.insight.total')}
                </Text>
                <Text style={styles.metricValue}>
                  {formatJPY(experience.recentInsight.totalSpend)}
                </Text>
              </View>
              <View style={styles.metric}>
                <Text style={styles.metricLabel}>
                  {t('home.progressive.insight.average')}
                </Text>
                <Text style={styles.metricValue}>
                  {formatJPY(
                    experience.recentInsight.averageSpendPerReceipt
                  )}
                </Text>
              </View>
            </View>
            <Text style={styles.insightCategoryTitle}>
              {t('home.progressive.insight.category')}
            </Text>
            <ProfileComposition
              categories={
                experience.recentInsight.categoryStructure.categories
              }
            />
            <Text style={styles.insightSummary}>
              {formatMilestoneSummary(
                experience.recentInsight.summary,
                t,
                categoryLabel
              )}
            </Text>
          </View>
        </>
      )}

      {experience.stage === 'frequent' && (
        <>
          <SectionTitle title={t('home.progressive.frequent.title')} />
          {experience.frequentProducts.length > 0 ? (
            <FrequentProductList
              products={experience.frequentProducts}
              onPress={onProductPress}
            />
          ) : (
            <View style={styles.panel}>
              <Text style={styles.fallbackText}>
                {t('home.progressive.frequent.preparing')}
              </Text>
            </View>
          )}
        </>
      )}

      {experience.stage === 'profile' && experience.profile && (
        <>
          <SectionTitle
            title={t('home.progressive.profile.title')}
            subtitle={t('home.progressive.profile.category')}
          />
          <View style={styles.panel}>
            <ProfileComposition
              categories={experience.profile.categoryStructure.categories}
            />
            {experience.profile.shoppingFrequency && (
              <Text style={styles.profileFact}>
                {t('home.progressive.profile.frequency', {
                  days: Number(
                    experience.profile.shoppingFrequency.averageIntervalDays.toFixed(
                      1
                    )
                  ),
                })}
              </Text>
            )}
            {experience.profile.recentChange && (
              <Text style={styles.insightSummary}>
                {formatMilestoneRecentChange(
                  experience.profile.recentChange,
                  t,
                  categoryLabel
                )}
              </Text>
            )}
          </View>
          {experience.frequentProducts.length > 0 && (
            <>
              <SectionTitle title={t('home.progressive.frequent.title')} />
              <FrequentProductList
                products={experience.frequentProducts}
                onPress={onProductPress}
              />
            </>
          )}
        </>
      )}


      {experience.analyticsUnavailable && experience.stage !== 'empty' && (
        <Text style={styles.analyticsFallback}>
          {t('home.progressive.analyticsUnavailable')}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  pageTitle: {
    color: UI_COLORS.textPrimary,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '900',
  },
  pageSubtitle: {
    marginTop: 5,
    color: UI_COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
  scanHero: {
    position: 'relative',
    marginTop: 20,
    minHeight: 148,
    borderRadius: UI_RADIUS.hero,
    backgroundColor: UI_COLORS.accent,
    borderWidth: 1,
    borderColor: UI_COLORS.accentDark,
    padding: 18,
    overflow: 'hidden',
  },
  scanCornerDetail: {
    position: 'absolute',
    right: 12,
    top: 12,
    width: 17,
    height: 17,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.72)',
  },
  scanIconTile: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  scanCopy: {
    marginTop: 13,
    maxWidth: '82%',
  },
  scanTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '900',
  },
  scanSubtitle: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    lineHeight: 20,
  },
  scanSupport: {
    marginTop: 1,
    color: 'rgba(255,255,255,0.74)',
    fontSize: 12,
    lineHeight: 17,
  },
  scanActionRow: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  scanActionLabel: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  scanHeroPressed: {
    backgroundColor: UI_COLORS.accentDark,
  },
  emptyValue: {
    marginTop: 18,
    paddingHorizontal: 4,
  },
  emptyTitle: {
    color: '#262b31',
    fontSize: 15,
    fontWeight: '700',
  },
  emptySubtitle: {
    marginTop: 5,
    color: '#727b86',
    fontSize: 13,
    lineHeight: 19,
  },
  panel: {
    borderRadius: UI_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: EDITORIAL_UI.panelBorder,
    backgroundColor: EDITORIAL_UI.panelBackground,
    overflow: 'hidden',
  },
  recentCard: {
    paddingVertical: 15,
    paddingHorizontal: 16,
  },
  recentTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  recentText: {
    flex: 1,
  },
  merchant: {
    color: '#15181c',
    fontSize: 17,
    fontWeight: '800',
  },
  recentMeta: {
    marginTop: 5,
    color: '#747d88',
    fontSize: 12,
  },
  recentAmount: {
    color: '#15181c',
    fontSize: 18,
    fontWeight: '800',
  },
  analyticsLoading: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  metricRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.borderSubtle,
  },
  metric: {
    flex: 1,
    padding: 16,
  },
  metricLabel: {
    color: '#747d88',
    fontSize: 12,
  },
  metricValue: {
    marginTop: 6,
    color: '#15181c',
    fontSize: 18,
    fontWeight: '800',
  },
  insightSummary: {
    marginHorizontal: 16,
    marginBottom: 16,
    paddingTop: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e1e4e8',
    color: '#3f4751',
    fontSize: 14,
    lineHeight: 21,
  },
  insightCategoryTitle: {
    marginTop: 2,
    paddingHorizontal: 16,
    color: '#747d88',
    fontSize: 12,
    fontWeight: '700',
  },
  productRow: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
  },
  productIconTile: {
    width: 34,
    height: 34,
    marginRight: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  borderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e1e4e8',
  },
  productText: {
    flex: 1,
  },
  productName: {
    color: '#171a1f',
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  productMeta: {
    marginTop: 4,
    color: '#747d88',
    fontSize: 12,
  },
  chevron: {
    marginLeft: 12,
    color: '#9aa2ad',
    fontSize: 25,
  },
  profileHeading: {
    paddingHorizontal: 16,
    paddingTop: 16,
    color: '#3f4751',
    fontSize: 13,
    fontWeight: '700',
  },
  profileComposition: {
    paddingHorizontal: 16,
    paddingVertical: 17,
  },
  profilePanel: {
    borderTopWidth: 3,
    borderTopColor: UI_COLORS.accent,
  },
  profileFact: {
    marginHorizontal: 16,
    marginBottom: 16,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
    color: '#3f4751',
    fontSize: 14,
    lineHeight: 21,
  },
  fallbackText: {
    padding: 16,
    color: '#68707a',
    fontSize: 13,
    lineHeight: 19,
  },
  analyticsFallback: {
    marginTop: 18,
    color: '#8a929c',
    fontSize: 12,
    textAlign: 'center',
  },
  disabled: {
    opacity: 0.58,
  },
  pressed: {
    opacity: 0.62,
  },
});
