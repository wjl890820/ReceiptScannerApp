import React from 'react';
import { StyleSheet } from 'react-native';

import { MerunoPressable } from '@/components/primitives/MerunoPressable';
import { MerunoSurface } from '@/components/primitives/MerunoSurface';
import { MerunoText } from '@/components/primitives/MerunoText';
import { t } from '@/lib/i18n';
import { UI_COLORS, UI_LAYOUT, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

export function ReceiptDuplicateGateRecoveryCard({
  processing,
  onOpenRecordAgain,
}: {
  processing: boolean;
  onOpenRecordAgain: () => void;
}) {
  return (
    <MerunoSurface style={styles.card}>
      <MerunoText role="sectionTitle" tone="primary">
        {t('scanReview.duplicateGate.recoveryTitle')}
      </MerunoText>
      <MerunoText role="bodySmall" tone="secondary" style={styles.body}>
        {t('scanReview.duplicateGate.recoveryBody')}
      </MerunoText>
      <MerunoPressable
        style={styles.primary}
        onPress={onOpenRecordAgain}
        disabled={processing}
        accessibilityRole="button"
        accessibilityLabel={t('scanReview.duplicateGate.openRecordAgain')}
      >
        <MerunoText role="button" tone="inverse">
          {t('scanReview.duplicateGate.openRecordAgain')}
        </MerunoText>
      </MerunoPressable>
    </MerunoSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: UI_SPACING.lg,
    padding: UI_SPACING.lg,
  },
  body: {
    marginTop: UI_SPACING.sm,
    marginBottom: UI_SPACING.md,
  },
  primary: {
    minHeight: UI_LAYOUT.controlMinHeight,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: UI_SPACING.md,
  },
});
