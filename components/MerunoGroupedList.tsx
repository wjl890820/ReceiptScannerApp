import React, { type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

export function MerunoGroupedList({ children }: { children: ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

export function MerunoGroupedRow({
  children,
  onPress,
  showDivider = true,
  dividerInset = 64,
  minHeight = 92,
  disabled = false,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  style,
}: {
  children: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  onPress?: () => void;
  showDivider?: boolean;
  dividerInset?: number;
  minHeight?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  style?: StyleProp<ViewStyle>;
}) {
  const content = (pressed: boolean) => (
    <>
      {typeof children === 'function' ? children({ pressed }) : children}
      {showDivider ? (
        <View
          pointerEvents="none"
          style={[styles.divider, { left: dividerInset }]}
        />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        style={[styles.row, { minHeight }, style]}
      >
        {content(false)}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      style={({ pressed }) => [
        styles.row,
        { minHeight },
        pressed && styles.rowPressed,
        disabled && styles.rowDisabled,
        style,
      ]}
    >
      {({ pressed }) => content(pressed)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    borderRadius: UI_RADIUS.card,
    backgroundColor: UI_COLORS.surface,
  },
  row: {
    position: 'relative',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 14,
    backgroundColor: UI_COLORS.surface,
  },
  rowPressed: {
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  rowDisabled: {
    opacity: 0.55,
  },
  divider: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: UI_COLORS.borderSubtle,
  },
});
