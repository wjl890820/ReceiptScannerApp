import React from 'react';
import {
  Pressable,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { resolveMerunoPressableOpacity } from '@/lib/merunoPrimitiveStyle';

export type MerunoPressableProps = PressableProps;

function resolvePressableStyle(
  style: MerunoPressableProps['style'],
  state: PressableStateCallbackType,
  disabled: boolean | null | undefined
): StyleProp<ViewStyle> {
  const interactionStyle: ViewStyle = {
    opacity: resolveMerunoPressableOpacity(disabled, state.pressed),
  };

  if (typeof style === 'function') {
    return [interactionStyle, style(state)];
  }

  return [interactionStyle, style];
}

export function MerunoPressable({
  style,
  disabled,
  ...rest
}: MerunoPressableProps) {
  return (
    <Pressable
      {...rest}
      disabled={disabled}
      style={(state) => resolvePressableStyle(style, state, disabled)}
    />
  );
}

export { resolveMerunoPressableOpacity } from '@/lib/merunoPrimitiveStyle';
