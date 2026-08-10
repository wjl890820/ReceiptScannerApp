import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';
import { RECEIPT_REVIEW_ERROR_TAGS } from '@/lib/reviewErrorTags';

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
          <Text style={styles.sectionTitle}>
            {t('scanReview.feedbackToggle')}
          </Text>
          <Text style={styles.sectionSubtitle}>
            {selectedCount > 0
              ? t('scanReview.feedbackSelected', { count: selectedCount })
              : t('scanReview.feedbackHint')}
          </Text>
        </View>
        <Text style={styles.chevron}>{feedbackOpen ? '▾' : '›'}</Text>
      </Pressable>

      {feedbackOpen ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{t('scanReview.errorTagsTitle')}</Text>
          <View style={styles.tagWrap}>
            {RECEIPT_REVIEW_ERROR_TAGS.map((tag) => {
              const on = errorTags.has(tag);
              return (
                <Pressable
                  key={tag}
                  onPress={() => onToggleErrorTag(tag)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[styles.tagChip, on && styles.tagChipOn]}
                >
                  <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>
                    {t(`scanReview.errorTags.${tag}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
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
            <Text style={styles.sectionTitle}>
              {t('scanReview.detailsToggle')}
            </Text>
            <Text style={styles.chevron}>{devOpen ? '▾' : '›'}</Text>
          </Pressable>
          {devOpen ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>{t('scanReview.traceId')}</Text>
              <Text selectable style={styles.mono}>
                {traceId || '—'}
              </Text>
              <Text style={[styles.cardLabel, { marginTop: 14 }]}>
                {t('scanReview.ocrRawTitle')}
              </Text>
              {ocrText ? (
                <Text selectable style={styles.ocrBlock}>
                  {ocrText}
                </Text>
              ) : (
                <Text style={styles.muted}>{t('scanReview.ocrRawEmpty')}</Text>
              )}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
  },
  sectionHeader: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  sectionHeaderText: {
    flex: 1,
    paddingRight: 12,
  },
  devHeader: {
    marginTop: 4,
  },
  sectionTitle: {
    color: '#171a1f',
    fontSize: 15,
    fontWeight: '800',
  },
  sectionSubtitle: {
    marginTop: 3,
    color: '#8a929c',
    fontSize: 12,
  },
  chevron: {
    color: '#9aa2ad',
    fontSize: 22,
    lineHeight: 24,
  },
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
    backgroundColor: '#fff',
    padding: 14,
  },
  cardLabel: {
    color: '#747d88',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 10,
  },
  tagWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tagChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d7dde5',
    backgroundColor: '#f7f8fa',
  },
  tagChipOn: {
    borderColor: '#1677ff',
    backgroundColor: '#1677ff',
  },
  tagChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#3f4751',
  },
  tagChipTextOn: {
    color: '#fff',
  },
  mono: {
    fontSize: 12,
    color: '#333',
  },
  ocrBlock: {
    fontSize: 11,
    color: '#333',
    backgroundColor: '#f5f7fa',
    padding: 10,
    borderRadius: 10,
    lineHeight: 16,
  },
  muted: {
    fontSize: 13,
    color: '#8a929c',
  },
  pressed: {
    opacity: 0.7,
  },
});
