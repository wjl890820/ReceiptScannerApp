import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { MerunoSurface } from '@/components/primitives/MerunoSurface';
import { MerunoText } from '@/components/primitives/MerunoText';
import { t } from '@/lib/i18n';
import { RECEIPT_REVIEW_ERROR_TAGS } from '@/lib/reviewErrorTags';
import { UI_COLORS, UI_OPACITY, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

type ReceiptReviewDetailsProps = {
  errorTags: Set<string>;
  onToggleErrorTag: (tag: string) => void;
  showDevDetails: boolean;
  traceId: string;
  ocrText: string;
};

export function ReceiptReviewDetails({
  errorTags,
  onToggleErrorTag,
  showDevDetails,
  traceId,
  ocrText,
}: ReceiptReviewDetailsProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const selectedCount = errorTags.size;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setFeedbackOpen((open) => !open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: feedbackOpen }}
        style={({ pressed }) => [styles.sectionHeader, pressed && styles.pressed]}
      >
        <View style={styles.sectionHeaderText}>
          <MerunoText role="bodySmall" tone="primary" style={styles.sectionTitle}>
            {t('scanReview.feedbackToggle')}
          </MerunoText>
          <MerunoText role="caption" tone="muted" style={styles.sectionSubtitle}>
            {selectedCount > 0
              ? t('scanReview.feedbackSelected', { count: selectedCount })
              : t('scanReview.feedbackHint')}
          </MerunoText>
        </View>
        <MaterialIcons
          name={feedbackOpen ? 'expand-more' : 'chevron-right'}
          size={20}
          color={UI_COLORS.textMuted}
          importantForAccessibility="no"
        />
      </Pressable>

      {feedbackOpen ? (
        <MerunoSurface style={styles.card}>
          <MerunoText role="caption" tone="secondary" style={styles.cardLabel}>
            {t('scanReview.errorTagsTitle')}
          </MerunoText>
          <View style={styles.tagWrap}>
            {RECEIPT_REVIEW_ERROR_TAGS.map((tag) => {
              const on = errorTags.has(tag);
              return (
                <Pressable
                  key={tag}
                  onPress={() => onToggleErrorTag(tag)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [
                    styles.tagChip,
                    on && styles.tagChipOn,
                    pressed && !on && styles.tagChipPressed,
                  ]}
                >
                  <MerunoText
                    role="chip"
                    tone={on ? 'inverse' : 'primary'}
                    style={styles.tagChipText}
                  >
                    {t(`scanReview.errorTags.${tag}`)}
                  </MerunoText>
                </Pressable>
              );
            })}
          </View>
        </MerunoSurface>
      ) : null}

      {showDevDetails ? (
        <>
          <Pressable
            onPress={() => setDevOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: devOpen }}
            style={({ pressed }) => [
              styles.sectionHeader,
              styles.devHeader,
              pressed && styles.pressed,
            ]}
          >
            <MerunoText role="bodySmall" tone="primary" style={styles.sectionTitle}>
              {t('scanReview.detailsToggle')}
            </MerunoText>
            <MaterialIcons
              name={devOpen ? 'expand-more' : 'chevron-right'}
              size={20}
              color={UI_COLORS.textMuted}
              importantForAccessibility="no"
            />
          </Pressable>
          {devOpen ? (
            <MerunoSurface style={styles.card}>
              <MerunoText role="caption" tone="secondary" style={styles.cardLabel}>
                {t('scanReview.traceId')}
              </MerunoText>
              <MerunoText selectable role="caption" tone="primary">
                {traceId || '—'}
              </MerunoText>
              <MerunoText
                role="caption"
                tone="secondary"
                style={[styles.cardLabel, styles.ocrLabel]}
              >
                {t('scanReview.ocrRawTitle')}
              </MerunoText>
              {ocrText ? (
                <MerunoText selectable role="caption" tone="primary" style={styles.ocrBlock}>
                  {ocrText}
                </MerunoText>
              ) : (
                <MerunoText role="meta" tone="muted">
                  {t('scanReview.ocrRawEmpty')}
                </MerunoText>
              )}
            </MerunoSurface>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: UI_SPACING.sm,
  },
  sectionHeader: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  sectionHeaderText: {
    flex: 1,
    paddingRight: UI_SPACING.md,
  },
  devHeader: {
    marginTop: UI_SPACING.xs,
  },
  sectionTitle: {
    fontWeight: '700',
  },
  sectionSubtitle: {
    marginTop: 3,
  },
  card: {
    padding: UI_SPACING.md,
  },
  cardLabel: {
    fontWeight: '600',
    marginBottom: 10,
  },
  tagWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: UI_SPACING.sm,
  },
  tagChip: {
    paddingVertical: UI_SPACING.sm,
    paddingHorizontal: UI_SPACING.md,
    borderRadius: UI_RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  tagChipOn: {
    borderColor: UI_COLORS.accent,
    backgroundColor: UI_COLORS.accent,
  },
  tagChipPressed: {
    backgroundColor: UI_COLORS.accentSoft,
  },
  tagChipText: {
    fontWeight: '700',
  },
  ocrLabel: {
    marginTop: UI_SPACING.md,
  },
  ocrBlock: {
    backgroundColor: UI_COLORS.surfaceMuted,
    padding: 10,
    borderRadius: UI_RADIUS.control,
    lineHeight: 16,
  },
  pressed: {
    opacity: UI_OPACITY.pressed,
  },
});
