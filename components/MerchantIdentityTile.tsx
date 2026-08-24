import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { merchantAccentColor } from '@/lib/merchantAccent';
import { normalizeMerchantName } from '@/lib/productNormalizer';

export function MerchantIdentityTile({
  merchant,
  merchantKey,
  size = 36,
}: {
  merchant: string | null | undefined;
  merchantKey?: string | null;
  size?: number;
}) {
  const color = merchantAccentColor(
    merchantKey ?? normalizeMerchantName(merchant ?? '')
  );

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.max(7, Math.round(size * 0.22)),
          backgroundColor: color,
        },
      ]}
    >
      <MaterialIcons
        name="storefront"
        size={Math.max(17, Math.round(size * 0.5))}
        color="#FFFFFF"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
