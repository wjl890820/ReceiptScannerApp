import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import { getCategoryLabel, getCategoryPresentation } from '@/lib/categoryPalette';
import { t } from '@/lib/i18n';
import type { ProductCategory } from '@/lib/productCategory';
import {
  formatCollapsedLineTotal,
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

const CONTROL_MIN_HEIGHT = 44;

type ReceiptItemCardProps = {
  name: string;
  category: ProductCategory;
  quantity: number;
  lineTotal: number;
  recognizedName: unknown;
  currency?: string;
  editable: boolean;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
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
  currency,
  editable,
  expanded,
  onExpand,
  onCollapse,
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
  const categoryLabel = getCategoryLabel(category);
  const collapsedAmount = formatCollapsedLineTotal(lineTotal, currency);
  const displayName = name.trim() || t('scanReview.itemNamePlaceholder');

  if (!expanded) {
    return (
      <Pressable
        onPress={() => {
          if (editable) onExpand();
        }}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel={t('scanReview.expandItemA11y', { name: displayName })}
        accessibilityState={{ expanded: false }}
        style={({ pressed }) => [
          styles.row,
          showDivider && styles.rowDivider,
          pressed && editable && styles.rowPressed,
          !editable && styles.disabled,
        ]}
      >
        <View style={styles.collapsedTop}>
          <MerunoText
            role="bodySmall"
            tone="primary"
            numberOfLines={1}
            style={styles.collapsedName}
          >
            {displayName}
          </MerunoText>
          <MerunoText role="amount" tone="primary" style={styles.collapsedAmount}>
            {collapsedAmount}
          </MerunoText>
        </View>

        <View style={styles.collapsedBottom}>
          <View style={styles.collapsedMeta}>
            <MaterialIcons
              name={categoryPresentation.icon}
              size={13}
              color={categoryPresentation.color}
            />
            <MerunoText
              role="meta"
              numberOfLines={1}
              style={[styles.collapsedCategory, { color: categoryPresentation.color }]}
            >
              {categoryLabel}
            </MerunoText>
            <MerunoText role="meta" tone="muted" style={styles.collapsedMetaSep}>
              ·
            </MerunoText>
            <MerunoText role="meta" tone="muted" numberOfLines={1} style={styles.collapsedQty}>
              {t('scanReview.qtyMeta', { count: quantity })}
            </MerunoText>
          </View>
          <MaterialIcons name="chevron-right" size={18} color={UI_COLORS.textMuted} />
        </View>
      </Pressable>
    );
  }

  return (
    <View style={[styles.row, styles.expandedRow, showDivider && styles.rowDivider]}>
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
          onPress={onCollapse}
          disabled={!editable}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.collapseItemA11y')}
          accessibilityState={{ expanded: true }}
          style={({ pressed }) => [
            styles.collapseBtn,
            !editable && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <MaterialIcons name="keyboard-arrow-up" size={22} color={UI_COLORS.textMuted} />
        </Pressable>
      </View>

      {showOriginal && original ? (
        <MerunoText role="caption" tone="muted" style={styles.originalHint} numberOfLines={1}>
          {t('scanReview.recognizedNameHint', { name: original })}
        </MerunoText>
      ) : null}

      <View style={styles.controlRow}>
        <Pressable
          onPress={onCategoryPress}
          disabled={!editable}
          accessibilityRole="button"
          accessibilityLabel={`${t('scanReview.category')}: ${categoryLabel}`}
          style={({ pressed }) => [
            styles.categoryControl,
            { borderColor: categoryPresentation.color },
            !editable && styles.disabled,
            pressed && styles.rowPressed,
          ]}
        >
          <MaterialIcons
            name={categoryPresentation.icon}
            size={13}
            color={categoryPresentation.color}
          />
          <MerunoText
            role="meta"
            numberOfLines={1}
            style={[styles.categoryLabel, { color: categoryPresentation.color }]}
          >
            {categoryLabel}
          </MerunoText>
        </Pressable>

        <View style={styles.quantityControl}>
          <MerunoText
            role="caption"
            tone="muted"
            pointerEvents="none"
            style={styles.controlLabel}
          >
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

        <View style={styles.subtotalControl}>
          <MerunoText
            role="caption"
            tone="muted"
            pointerEvents="none"
            style={styles.controlLabel}
          >
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

      <Pressable
        onPress={onDelete}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel={t('scanReview.deleteItem')}
        style={({ pressed }) => [
          styles.deleteAction,
          !editable && styles.disabled,
          pressed && styles.deleteActionPressed,
        ]}
      >
        <MaterialIcons
          name="delete-outline"
          size={18}
          color={UI_COLORS.destructive}
          style={styles.deleteActionIcon}
        />
        <MerunoText role="bodySmall" tone="destructive" style={styles.deleteActionText}>
          {t('scanReview.deleteItemAction')}
        </MerunoText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: UI_COLORS.surface,
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: UI_SPACING.sm,
  },
  expandedRow: {
    paddingVertical: UI_SPACING.sm,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.borderSubtle,
  },
  collapsedTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: UI_SPACING.sm,
    minHeight: 24,
  },
  collapsedName: {
    flex: 1,
    minWidth: 0,
    fontWeight: '700',
  },
  collapsedAmount: {
    flexShrink: 0,
    textAlign: 'right',
  },
  collapsedBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: UI_SPACING.sm,
    marginTop: 6,
    minHeight: 20,
  },
  collapsedMeta: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: UI_SPACING.xs,
  },
  collapsedCategory: {
    flexShrink: 1,
    fontWeight: '600',
  },
  collapsedMetaSep: {
    fontWeight: '600',
  },
  collapsedQty: {
    flexShrink: 0,
    fontWeight: '600',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: UI_SPACING.sm,
  },
  nameInput: {
    ...TEXT_ROLES.bodySmall,
    flex: 1,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
    paddingVertical: UI_SPACING.xs,
    minHeight: CONTROL_MIN_HEIGHT,
  },
  collapseBtn: {
    width: CONTROL_MIN_HEIGHT,
    height: CONTROL_MIN_HEIGHT,
    borderRadius: UI_RADIUS.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  originalHint: {
    marginTop: UI_SPACING.xs,
    marginBottom: UI_SPACING.xs,
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: UI_SPACING.sm,
    marginTop: UI_SPACING.sm,
  },
  categoryControl: {
    flexShrink: 1,
    maxWidth: 128,
    minHeight: CONTROL_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: UI_SPACING.xs,
    paddingHorizontal: UI_SPACING.sm,
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: UI_COLORS.surface,
  },
  categoryLabel: {
    flexShrink: 1,
    fontWeight: '600',
  },
  quantityControl: {
    width: 76,
    height: CONTROL_MIN_HEIGHT,
    borderRadius: UI_RADIUS.input,
    backgroundColor: UI_COLORS.surfaceMuted,
    paddingHorizontal: UI_SPACING.sm,
  },
  subtotalControl: {
    flex: 1,
    minWidth: 0,
    height: CONTROL_MIN_HEIGHT,
    borderRadius: UI_RADIUS.input,
    backgroundColor: UI_COLORS.surfaceMuted,
    paddingHorizontal: UI_SPACING.sm,
  },
  controlLabel: {
    position: 'absolute',
    top: 3,
    left: UI_SPACING.sm,
    right: UI_SPACING.sm,
    fontWeight: '600',
  },
  qtyInput: {
    ...TEXT_ROLES.bodySmall,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: UI_COLORS.textPrimary,
    width: '100%',
    height: CONTROL_MIN_HEIGHT,
    minHeight: CONTROL_MIN_HEIGHT,
    paddingTop: 13,
    paddingVertical: 0,
  },
  lineTotalInput: {
    ...TEXT_ROLES.amount,
    color: UI_COLORS.textPrimary,
    width: '100%',
    height: CONTROL_MIN_HEIGHT,
    minHeight: CONTROL_MIN_HEIGHT,
    paddingTop: 12,
    paddingVertical: 0,
  },
  deleteAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: UI_SPACING.xs,
    minHeight: CONTROL_MIN_HEIGHT,
    marginTop: UI_SPACING.sm,
    borderRadius: UI_RADIUS.control,
  },
  deleteActionPressed: {
    opacity: UI_OPACITY.pressed,
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  deleteActionIcon: {
    marginTop: 1,
  },
  deleteActionText: {
    fontWeight: '600',
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
