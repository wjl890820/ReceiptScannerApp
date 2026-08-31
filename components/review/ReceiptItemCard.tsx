import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import { getCategoryLabel, getCategoryPresentation } from '@/lib/categoryPalette';
import { t } from '@/lib/i18n';
import type { ProductCategory } from '@/lib/productCategory';
import {
  normalizeRecognizedName,
  shouldShowRecognizedNameHint,
} from '@/lib/scanReviewPresentation';
import {
  TEXT_ROLES,
  UI_COLORS,
  UI_OPACITY,
  UI_RADIUS,
  UI_SPACING,
} from '@/lib/uiTokens';

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
  showDivider?: boolean;
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
  showDivider = true,
}: ReceiptItemCardProps) {
  const original = normalizeRecognizedName(recognizedName);
  const showOriginal = shouldShowRecognizedNameHint(name, recognizedName);
  const categoryPresentation = getCategoryPresentation(category);

  return (
    <View style={[styles.row, showDivider && styles.rowDivider]}>
      <View style={styles.head}>
        <TextInput
          value={name}
          onChangeText={onNameChange}
          style={styles.nameInput}
          editable={editable}
          placeholder={t('scanReview.itemNamePlaceholder')}
          placeholderTextColor={UI_COLORS.textMuted}
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
          <MaterialIcons
            name="delete-outline"
            size={18}
            color={UI_COLORS.destructive}
          />
        </Pressable>
      </View>

      {showOriginal && original ? (
        <MerunoText role="caption" tone="muted" style={styles.originalHint} numberOfLines={1}>
          {t('scanReview.recognizedNameHint', { name: original })}
        </MerunoText>
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
          pressed && styles.rowPressed,
        ]}
      >
        <MaterialIcons
          name={categoryPresentation.icon}
          size={14}
          color={categoryPresentation.color}
        />
        <MerunoText
          role="meta"
          style={[styles.categoryPillText, { color: categoryPresentation.color }]}
        >
          {getCategoryLabel(category)}
        </MerunoText>
      </Pressable>

      <View style={styles.metricsRow}>
        <View style={styles.metric}>
          <MerunoText role="caption" tone="muted" style={styles.metricLabel}>
            {t('scanReview.qty')}
          </MerunoText>
          <TextInput
            value={String(quantity)}
            onChangeText={onQuantityChange}
            keyboardType="number-pad"
            style={styles.qtyInput}
            editable={editable}
            accessibilityLabel={t('scanReview.qty')}
          />
        </View>
        <View style={[styles.metric, styles.metricWide]}>
          <MerunoText role="caption" tone="muted" style={styles.metricLabel}>
            {t('scanReview.lineTotal')}
          </MerunoText>
          <TextInput
            value={String(lineTotal)}
            onChangeText={onLineTotalChange}
            keyboardType="decimal-pad"
            style={styles.lineTotalInput}
            editable={editable}
            accessibilityLabel={t('scanReview.lineTotal')}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: UI_COLORS.surface,
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: UI_SPACING.md,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.borderSubtle,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: UI_SPACING.sm,
  },
  nameInput: {
    ...TEXT_ROLES.bodySmall,
    flex: 1,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
    paddingVertical: 0,
    minHeight: 24,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: UI_RADIUS.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  originalHint: {
    marginTop: UI_SPACING.xs,
  },
  categoryPill: {
    marginTop: 10,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: UI_SPACING.md,
    paddingVertical: 7,
    minHeight: 32,
    borderRadius: UI_RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: UI_COLORS.surface,
  },
  categoryPillText: {
    fontWeight: '700',
  },
  metricsRow: {
    flexDirection: 'row',
    marginTop: UI_SPACING.md,
    gap: UI_SPACING.sm,
  },
  metric: {
    minWidth: 72,
    borderRadius: UI_RADIUS.input,
    backgroundColor: UI_COLORS.surfaceMuted,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  metricWide: {
    flex: 1,
    minWidth: 0,
  },
  metricLabel: {
    fontWeight: '600',
    marginBottom: 2,
  },
  qtyInput: {
    ...TEXT_ROLES.bodySmall,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: UI_COLORS.textPrimary,
    paddingVertical: 0,
    minHeight: 22,
  },
  lineTotalInput: {
    ...TEXT_ROLES.amount,
    color: UI_COLORS.textPrimary,
    paddingVertical: 0,
    minHeight: 22,
  },
  disabled: {
    opacity: UI_OPACITY.disabled,
  },
  pressed: {
    opacity: UI_OPACITY.pressed,
  },
  rowPressed: {
    backgroundColor: UI_COLORS.surfaceMuted,
  },
});
