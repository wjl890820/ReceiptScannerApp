import { useRouter, type Href } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDate } from '@/lib/formatDate';
import { t } from '@/lib/i18n';
import type { PostSavePurchaseMemory } from '@/lib/postSavePurchaseMemory';
import { resolvePostSavePurchaseMemoryPresentation } from '@/lib/postSavePurchaseMemoryPresentation';
import { buildProductDetailHref } from '@/lib/productDetailTarget';
import { UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

export function PostSavePurchaseMemoryCard({
  memory,
}: {
  memory: PostSavePurchaseMemory;
}) {
  const router = useRouter();
  const presentation = resolvePostSavePurchaseMemoryPresentation(memory);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('postSaveSummary.purchaseMemory.title')}</Text>
      <Text style={styles.productName}>{memory.displayName}</Text>
      <Text style={styles.body}>
        {t('postSaveSummary.purchaseMemory.purchaseCount', {
          count: memory.purchaseOccurrenceCount,
        })}
      </Text>
      <Text style={styles.body}>
        {t('postSaveSummary.purchaseMemory.previousPurchase', {
          date: formatDate(memory.previousPurchase.occurredAt),
        })}
      </Text>
      {memory.previousPurchase.merchantName ? (
        <Text style={styles.body}>
          {t('postSaveSummary.purchaseMemory.previousMerchant', {
            merchant: memory.previousPurchase.merchantName,
          })}
        </Text>
      ) : null}

      {presentation.priceChangeTextKey ? (
        <Text style={styles.priceHighlight}>
          {presentation.priceChangeTextParams
            ? t(
                presentation.priceChangeTextKey,
                presentation.priceChangeTextParams
              )
            : t(presentation.priceChangeTextKey)}
        </Text>
      ) : null}

      <Pressable
        onPress={() =>
          router.push(buildProductDetailHref(memory.target) as Href)
        }
        accessibilityRole="button"
        accessibilityLabel={t('postSaveSummary.purchaseMemory.viewHistory')}
        style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
      >
        <Text style={styles.linkButtonText}>
          {t('postSaveSummary.purchaseMemory.viewHistory')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 20,
    padding: 16,
    borderRadius: UI_RADIUS.card,
    backgroundColor: UI_COLORS.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
  },
  title: {
    color: UI_COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  productName: {
    marginTop: 8,
    color: UI_COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  body: {
    marginTop: 6,
    color: UI_COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  priceHighlight: {
    marginTop: 10,
    color: UI_COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  linkButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  linkButtonText: {
    color: UI_COLORS.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.75,
  },
});
