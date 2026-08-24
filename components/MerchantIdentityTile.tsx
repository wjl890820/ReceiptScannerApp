import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { merchantAccentColor } from '@/lib/merchantAccent';
import { normalizeMerchantName } from '@/lib/productNormalizer';

export function merchantIdentityGlyph(merchant: string | null | undefined): string {
  const normalized = (merchant ?? '').trim();
  return Array.from(normalized)[0]?.toUpperCase() ?? '?';
}

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
      <Text style={[styles.glyph, { fontSize: Math.max(14, size * 0.42) }]}>
        {merchantIdentityGlyph(merchant)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
});
