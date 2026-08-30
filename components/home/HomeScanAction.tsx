import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import { t } from '@/lib/i18n';
import { UI_COLORS, UI_OPACITY, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

type HomeScanActionProps = {
  scanning: boolean;
  processingProgress: { current: number; total: number } | null;
  onScan: () => void;
};

export function HomeScanAction({
  scanning,
  processingProgress,
  onScan,
}: HomeScanActionProps) {
  const scanLabel = processingProgress
    ? t('home.scan.processingMulti', {
        current: processingProgress.current,
        total: processingProgress.total,
      })
    : scanning
      ? t('home.scan.processing')
      : t('home.scan.button');

  return (
    <Pressable
      onPress={onScan}
      disabled={scanning}
      accessibilityRole="button"
      accessibilityLabel={scanLabel}
      style={({ pressed }) => [
        styles.scanHero,
        scanning && styles.disabled,
        pressed && !scanning && styles.scanHeroPressed,
      ]}
    >
      <View style={styles.scanIconTile} importantForAccessibility="no">
        {scanning && !processingProgress ? (
          <ActivityIndicator size="small" color={UI_COLORS.surface} />
        ) : (
          <MaterialIcons
            name="document-scanner"
            size={30}
            color={UI_COLORS.surface}
          />
        )}
      </View>
      <View style={styles.scanCopy}>
        <MerunoText role="heroTitle" tone="inverse">
          {t('home.progressive.scan.title')}
        </MerunoText>
        <MerunoText role="chip" tone="inverse" style={styles.scanSubtitle}>
          {t('home.progressive.scan.subtitle')}
        </MerunoText>
        <MerunoText role="caption" tone="inverse" style={styles.scanSupport}>
          {t('home.progressive.scan.support')}
        </MerunoText>
      </View>
      <View style={styles.scanActionRow}>
        <MerunoText role="meta" tone="inverse" style={styles.scanActionLabel}>
          {scanLabel}
        </MerunoText>
        {!scanning ? (
          <MaterialIcons
            name="arrow-forward"
            size={18}
            color={UI_COLORS.surface}
          />
        ) : null}
      </View>
      <View style={styles.scanCornerDetail} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scanHero: {
    position: 'relative',
    marginTop: UI_SPACING.xl,
    minHeight: 152,
    borderRadius: UI_RADIUS.hero,
    backgroundColor: UI_COLORS.accent,
    borderWidth: 1,
    borderColor: UI_COLORS.accentDark,
    padding: 18,
    overflow: 'hidden',
  },
  scanCornerDetail: {
    position: 'absolute',
    right: UI_SPACING.md,
    top: UI_SPACING.md,
    width: 17,
    height: 17,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.72)',
  },
  scanIconTile: {
    width: 44,
    height: 44,
    borderRadius: UI_RADIUS.card,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  scanCopy: {
    marginTop: 13,
    maxWidth: '82%',
  },
  scanSubtitle: {
    marginTop: UI_SPACING.xs,
    opacity: 0.9,
  },
  scanSupport: {
    marginTop: 1,
    opacity: 0.74,
  },
  scanActionRow: {
    position: 'absolute',
    right: UI_SPACING.lg,
    bottom: UI_SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  scanActionLabel: {
    fontWeight: '800',
  },
  scanHeroPressed: {
    backgroundColor: UI_COLORS.accentDark,
  },
  disabled: {
    opacity: UI_OPACITY.subdued,
  },
});
