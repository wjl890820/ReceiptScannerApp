import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import { t } from '@/lib/i18n';
import {
  UI_COLORS,
  UI_OPACITY,
  UI_RADIUS,
  UI_SHADOW,
  UI_SPACING,
} from '@/lib/uiTokens';

type ReceiptReviewSaveBarProps = {
  saving: boolean;
  bottomInset: number;
  onSave: () => void;
  onLayoutHeight?: (height: number) => void;
};

export function ReceiptReviewSaveBar({
  saving,
  bottomInset,
  onSave,
  onLayoutHeight,
}: ReceiptReviewSaveBarProps) {
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(bottomInset, UI_SPACING.md) }]}
      onLayout={(e) => onLayoutHeight?.(e.nativeEvent.layout.height)}
    >
      <Pressable
        onPress={onSave}
        disabled={saving}
        accessibilityRole="button"
        accessibilityLabel={saving ? t('scanReview.saving') : t('scanReview.save')}
        style={({ pressed }) => [
          styles.button,
          saving && styles.disabled,
          pressed && !saving && styles.buttonPressed,
        ]}
      >
        {saving ? (
          <ActivityIndicator size="small" color={UI_COLORS.surface} />
        ) : null}
        <MerunoText role="button" tone="inverse">
          {saving ? t('scanReview.saving') : t('scanReview.save')}
        </MerunoText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 10,
    paddingHorizontal: UI_SPACING.lg,
    backgroundColor: UI_COLORS.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.border,
    ...UI_SHADOW.sticky,
  },
  button: {
    minHeight: 52,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.accent,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.accentDark,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: UI_SPACING.sm,
  },
  buttonPressed: {
    backgroundColor: UI_COLORS.accentDark,
  },
  disabled: {
    opacity: UI_OPACITY.disabled,
  },
});
