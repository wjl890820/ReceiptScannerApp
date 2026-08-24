import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { getCategoryLabel, getCategoryPresentation } from '@/lib/categoryPalette';
import { t } from '@/lib/i18n';
import type { ProductCategory } from '@/lib/productCategory';
import {
  normalizeRecognizedName,
  shouldShowRecognizedNameHint,
} from '@/lib/scanReviewPresentation';

type ReceiptItemCardProps = {
  name: string;
  category: ProductCategory;
  quantity: number;
  lineTotal: number;
  recognizedName: unknown;
  editable: boolean;
  onNameChange: (value: string) => void;
  onCategoryPress: () => void;
  onQuantityChange: (value: string) => void;
  onLineTotalChange: (value: string) => void;
  onDelete: () => void;
};

export function ReceiptItemCard({
  name,
  category,
  quantity,
  lineTotal,
  recognizedName,
  editable,
  onNameChange,
  onCategoryPress,
  onQuantityChange,
  onLineTotalChange,
  onDelete,
}: ReceiptItemCardProps) {
  const original = normalizeRecognizedName(recognizedName);
  const showOriginal = shouldShowRecognizedNameHint(name, recognizedName);
  const categoryPresentation = getCategoryPresentation(category);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <TextInput
          value={name}
          onChangeText={onNameChange}
          style={[styles.nameInput, { flex: 1 }]}
          editable={editable}
          placeholder={t('scanReview.itemNamePlaceholder')}
          accessibilityLabel={t('scanReview.itemName')}
        />
        <Pressable
          onPress={onDelete}
          disabled={!editable}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.deleteItem')}
          style={({ pressed }) => [
            styles.deleteBtn,
            !editable && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <MaterialIcons name="delete-outline" size={20} color="#d94848" />
        </Pressable>
      </View>

      {showOriginal && original ? (
        <Text style={styles.originalHint} numberOfLines={1}>
          {t('scanReview.recognizedNameHint', { name: original })}
        </Text>
      ) : null}

      <Pressable
        onPress={onCategoryPress}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel={`${t('scanReview.category')}: ${getCategoryLabel(category)}`}
        style={({ pressed }) => [
          styles.categoryPill,
          { borderColor: categoryPresentation.color },
          !editable && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        <MaterialIcons
          name={categoryPresentation.icon}
          size={15}
          color={categoryPresentation.color}
        />
        <Text
          style={[styles.categoryPillText, { color: categoryPresentation.color }]}
        >
          {getCategoryLabel(category)}
        </Text>
      </Pressable>

      <View style={styles.metricsRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{t('scanReview.qty')}</Text>
          <TextInput
            value={String(quantity)}
            onChangeText={onQuantityChange}
            keyboardType="number-pad"
            style={styles.metricInput}
            editable={editable}
            accessibilityLabel={t('scanReview.qty')}
          />
        </View>
        <View style={[styles.metric, styles.metricWide]}>
          <Text style={styles.metricLabel}>{t('scanReview.lineTotal')}</Text>
          <TextInput
            value={String(lineTotal)}
            onChangeText={onLineTotalChange}
            keyboardType="decimal-pad"
            style={styles.metricInput}
            editable={editable}
            accessibilityLabel={t('scanReview.lineTotal')}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8ebef',
    backgroundColor: '#fff',
    padding: 14,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  nameInput: {
    color: '#15181c',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    paddingVertical: 0,
    minHeight: 24,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff5f5',
  },
  originalHint: {
    marginTop: 6,
    color: '#8a929c',
    fontSize: 12,
  },
  categoryPill: {
    marginTop: 10,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#FFFFFF',
  },
  categoryPillText: {
    fontSize: 13,
    fontWeight: '800',
  },
  metricsRow: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  metric: {
    width: 88,
    borderRadius: 8,
    backgroundColor: '#f5f7fa',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  metricWide: {
    flex: 1,
    width: undefined,
  },
  metricLabel: {
    color: '#747d88',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  metricInput: {
    color: '#15181c',
    fontSize: 16,
    fontWeight: '800',
    paddingVertical: 0,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
});
