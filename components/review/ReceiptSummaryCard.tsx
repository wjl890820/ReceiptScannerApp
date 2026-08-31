import React from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { MerchantIdentityTile } from '@/components/MerchantIdentityTile';
import { MerunoSurface } from '@/components/primitives/MerunoSurface';
import { MerunoText } from '@/components/primitives/MerunoText';
import { t } from '@/lib/i18n';
import {
  TEXT_ROLES,
  UI_COLORS,
  UI_RADIUS,
  UI_SPACING,
} from '@/lib/uiTokens';

type ReceiptSummaryCardProps = {
  merchant: string;
  dateStr: string;
  totalStr: string;
  taxStr: string;
  currency: string;
  note: string;
  amountMismatch: boolean;
  dateNeedsConfirm: boolean;
  editable: boolean;
  onMerchantChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onTotalChange: (value: string) => void;
  onTaxChange: (value: string) => void;
  onCurrencyChange: (value: string) => void;
  onNoteChange: (value: string) => void;
};

function ConfirmSignal({ message }: { message: string }) {
  return (
    <View style={styles.signal}>
      <MerunoText role="meta" tone="primary" style={styles.signalText}>
        {message}
      </MerunoText>
    </View>
  );
}

export function ReceiptSummaryCard({
  merchant,
  dateStr,
  totalStr,
  taxStr,
  currency,
  note,
  amountMismatch,
  dateNeedsConfirm,
  editable,
  onMerchantChange,
  onDateChange,
  onTotalChange,
  onTaxChange,
  onCurrencyChange,
  onNoteChange,
}: ReceiptSummaryCardProps) {
  return (
    <MerunoSurface style={styles.card}>
      {amountMismatch ? (
        <ConfirmSignal message={t('scanReview.amountMismatchWarning')} />
      ) : null}
      {dateNeedsConfirm ? (
        <ConfirmSignal message={t('scanReview.dateNeedsConfirm')} />
      ) : null}

      <View style={styles.merchantRow}>
        <MerchantIdentityTile merchant={merchant} size={40} />
        <View style={styles.merchantInputs}>
          <TextInput
            value={merchant}
            onChangeText={onMerchantChange}
            style={styles.merchantInput}
            editable={editable}
            placeholder={t('scanReview.merchantPlaceholder')}
            placeholderTextColor={UI_COLORS.textMuted}
            accessibilityLabel={t('scanReview.merchant')}
          />
          <TextInput
            value={dateStr}
            onChangeText={onDateChange}
            style={styles.dateInput}
            editable={editable}
            placeholder={t('scanReview.datePlaceholder')}
            placeholderTextColor={UI_COLORS.textMuted}
            accessibilityLabel={t('scanReview.date')}
          />
        </View>
      </View>

      <View style={styles.totalBlock}>
        <MerunoText role="caption" tone="secondary" style={styles.fieldLabel}>
          {t('scanReview.total')}
        </MerunoText>
        <TextInput
          value={totalStr}
          onChangeText={onTotalChange}
          keyboardType="decimal-pad"
          style={styles.totalInput}
          editable={editable}
          accessibilityLabel={t('scanReview.total')}
        />
      </View>

      <View style={styles.supportRow}>
        <View style={styles.supportField}>
          <MerunoText role="caption" tone="muted" style={styles.fieldLabel}>
            {t('scanReview.tax')}
          </MerunoText>
          <TextInput
            value={taxStr}
            onChangeText={onTaxChange}
            keyboardType="decimal-pad"
            style={styles.supportInput}
            editable={editable}
            accessibilityLabel={t('scanReview.tax')}
          />
        </View>
        <View style={[styles.supportField, styles.supportFieldBorder]}>
          <MerunoText role="caption" tone="muted" style={styles.fieldLabel}>
            {t('scanReview.currency')}
          </MerunoText>
          <TextInput
            value={currency}
            onChangeText={onCurrencyChange}
            style={styles.supportInput}
            editable={editable}
            autoCapitalize="characters"
            accessibilityLabel={t('scanReview.currency')}
          />
        </View>
      </View>

      <MerunoText role="caption" tone="muted" style={styles.noteLabel}>
        {t('scanReview.note')}
      </MerunoText>
      <TextInput
        value={note}
        onChangeText={onNoteChange}
        style={styles.noteInput}
        multiline
        editable={editable}
        placeholder={t('scanReview.notePlaceholder')}
        placeholderTextColor={UI_COLORS.textMuted}
        accessibilityLabel={t('scanReview.note')}
      />
    </MerunoSurface>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: UI_SPACING.lg,
  },
  signal: {
    backgroundColor: UI_COLORS.surfaceMuted,
    borderColor: UI_COLORS.signal,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: UI_RADIUS.control,
    paddingVertical: 10,
    paddingHorizontal: UI_SPACING.md,
    marginBottom: UI_SPACING.md,
  },
  signalText: {
    lineHeight: 18,
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: UI_SPACING.md,
  },
  merchantInputs: {
    flex: 1,
    minWidth: 0,
  },
  merchantInput: {
    ...TEXT_ROLES.heroTitle,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
    paddingVertical: 2,
  },
  dateInput: {
    ...TEXT_ROLES.meta,
    marginTop: 6,
    color: UI_COLORS.textSecondary,
    paddingVertical: 2,
  },
  totalBlock: {
    marginTop: UI_SPACING.lg,
    paddingTop: UI_SPACING.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
  },
  fieldLabel: {
    fontWeight: '600',
    marginBottom: UI_SPACING.xs,
  },
  totalInput: {
    ...TEXT_ROLES.metric,
    color: UI_COLORS.textPrimary,
    paddingVertical: 0,
    minHeight: 32,
  },
  supportRow: {
    flexDirection: 'row',
    marginTop: UI_SPACING.md,
  },
  supportField: {
    flex: 1,
    minWidth: 0,
    paddingRight: UI_SPACING.md,
  },
  supportFieldBorder: {
    paddingRight: 0,
    paddingLeft: UI_SPACING.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: UI_COLORS.borderSubtle,
  },
  supportInput: {
    ...TEXT_ROLES.bodySmall,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: UI_COLORS.textPrimary,
    paddingVertical: 0,
    minHeight: 22,
  },
  noteLabel: {
    marginTop: UI_SPACING.md,
    marginBottom: UI_SPACING.xs,
    fontWeight: '600',
  },
  noteInput: {
    ...TEXT_ROLES.meta,
    minHeight: 52,
    borderRadius: UI_RADIUS.input,
    backgroundColor: UI_COLORS.surfaceMuted,
    paddingHorizontal: UI_SPACING.md,
    paddingVertical: 10,
    color: UI_COLORS.textPrimary,
    textAlignVertical: 'top',
  },
});
