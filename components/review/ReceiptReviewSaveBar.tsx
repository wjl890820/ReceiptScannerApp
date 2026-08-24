import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';

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
      style={[styles.bar, { paddingBottom: Math.max(bottomInset, 12) }]}
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
          pressed && styles.pressed,
        ]}
      >
        {saving ? <ActivityIndicator size="small" color="#fff" /> : null}
        <Text style={styles.buttonText}>
          {saving ? t('scanReview.saving') : t('scanReview.save')}
        </Text>
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
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e7e9ec',
  },
  button: {
    minHeight: 52,
    borderRadius: 9,
    backgroundColor: '#1677ff',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.58,
  },
  pressed: {
    opacity: 0.82,
  },
});
