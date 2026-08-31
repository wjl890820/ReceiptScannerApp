import React from 'react';
import { StyleSheet, View } from 'react-native';

import { MerunoPressable } from '@/components/primitives/MerunoPressable';
import { MerunoSurface } from '@/components/primitives/MerunoSurface';
import { MerunoText } from '@/components/primitives/MerunoText';
import { formatDate } from '@/lib/formatDate';
import { t } from '@/lib/i18n';
import type { ScanReviewDuplicateGateMatch } from '@/lib/scanReviewDuplicateGate';
import { UI_COLORS, UI_LAYOUT, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

export function ReceiptDuplicateGateCard({
  match,
  processing,
  onUseSavedReceipt,
  onContinueReview,
}: {
  match: ScanReviewDuplicateGateMatch;
  processing: boolean;
  onUseSavedReceipt: () => void;
  onContinueReview: () => void;
}) {
  return (
    <MerunoSurface style={styles.card}>
      <MerunoText role="sectionTitle" tone="primary">
        {t('scanReview.duplicateGate.title')}
      </MerunoText>
      <MerunoText role="bodySmall" tone="secondary" style={styles.body}>
        {t('scanReview.duplicateGate.body')}
      </MerunoText>

      <MerunoSurface variant="muted" style={styles.summary}>
        <MerunoText role="bodySmall" tone="primary" style={styles.merchant}>
          {match.merchantDisplay}
        </MerunoText>
        <MerunoText role="meta" tone="secondary" style={styles.meta}>
          {formatDate(match.transactionAt)}
        </MerunoText>
        <View style={styles.summaryBottom}>
          <MerunoText role="bodySmall" tone="primary" style={styles.total}>
            {match.currency} {match.total.toLocaleString()}
          </MerunoText>
          <MerunoText role="meta" tone="secondary">
            {t('scanReview.duplicateGate.itemCount', {
              count: match.itemCount,
            })}
          </MerunoText>
        </View>
      </MerunoSurface>

      <View style={styles.actions}>
        <MerunoPressable
          style={styles.primary}
          onPress={onUseSavedReceipt}
          disabled={processing}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.duplicateGate.useSaved')}
        >
          <MerunoText role="button" tone="inverse">
            {t('scanReview.duplicateGate.useSaved')}
          </MerunoText>
        </MerunoPressable>
        <MerunoPressable
          style={styles.secondary}
          onPress={onContinueReview}
          disabled={processing}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.duplicateGate.continueReview')}
        >
          <MerunoText role="button" tone="accent">
            {t('scanReview.duplicateGate.continueReview')}
          </MerunoText>
        </MerunoPressable>
      </View>
    </MerunoSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: UI_SPACING.lg,
    padding: UI_SPACING.lg,
  },
  body: {
    marginTop: UI_SPACING.sm,
  },
  summary: {
    marginTop: UI_SPACING.md,
    padding: UI_SPACING.md,
  },
  merchant: {
    fontWeight: '700',
  },
  meta: {
    marginTop: UI_SPACING.xs,
  },
  summaryBottom: {
    marginTop: UI_SPACING.sm,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: UI_SPACING.md,
  },
  total: {
    fontWeight: '800',
  },
  actions: {
    marginTop: UI_SPACING.md,
    gap: UI_SPACING.sm,
  },
  primary: {
    minHeight: UI_LAYOUT.controlMinHeight,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: UI_SPACING.md,
  },
  secondary: {
    minHeight: UI_LAYOUT.controlMinHeight,
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: UI_SPACING.md,
  },
});
