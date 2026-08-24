import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { t } from '@/lib/i18n';
import { MerchantIdentityTile } from '@/components/MerchantIdentityTile';

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
    <View style={styles.card}>
      {amountMismatch ? (
        <View style={styles.warningBanner}>
          <Text style={styles.warningBannerText}>
            {t('scanReview.amountMismatchWarning')}
          </Text>
        </View>
      ) : null}
      {dateNeedsConfirm ? (
        <View style={styles.warningBanner}>
          <Text style={styles.warningBannerText}>
            {t('scanReview.dateNeedsConfirm')}
          </Text>
        </View>
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
            accessibilityLabel={t('scanReview.merchant')}
          />
          <TextInput
            value={dateStr}
            onChangeText={onDateChange}
            style={styles.dateInput}
            editable={editable}
            placeholder={t('scanReview.datePlaceholder')}
            accessibilityLabel={t('scanReview.date')}
          />
        </View>
      </View>

      <View style={styles.metricsRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{t('scanReview.total')}</Text>
          <TextInput
            value={totalStr}
            onChangeText={onTotalChange}
            keyboardType="decimal-pad"
            style={styles.metricInput}
            editable={editable}
            accessibilityLabel={t('scanReview.total')}
          />
        </View>
        <View style={[styles.metric, styles.metricBorder]}>
          <Text style={styles.metricLabel}>{t('scanReview.tax')}</Text>
          <TextInput
            value={taxStr}
            onChangeText={onTaxChange}
            keyboardType="decimal-pad"
            style={styles.metricInput}
            editable={editable}
            accessibilityLabel={t('scanReview.tax')}
          />
        </View>
        <View style={[styles.metric, styles.metricBorder]}>
          <Text style={styles.metricLabel}>{t('scanReview.currency')}</Text>
          <TextInput
            value={currency}
            onChangeText={onCurrencyChange}
            style={styles.metricInput}
            editable={editable}
            autoCapitalize="characters"
            accessibilityLabel={t('scanReview.currency')}
          />
        </View>
      </View>

      <Text style={styles.noteLabel}>{t('scanReview.note')}</Text>
      <TextInput
        value={note}
        onChangeText={onNoteChange}
        style={styles.noteInput}
        multiline
        editable={editable}
        placeholder={t('scanReview.notePlaceholder')}
        accessibilityLabel={t('scanReview.note')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
    backgroundColor: '#fff',
    padding: 16,
  },
  warningBanner: {
    backgroundColor: '#FFF8EC',
    borderColor: '#F0C36D',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  warningBannerText: {
    color: '#8A5A00',
    fontSize: 13,
    lineHeight: 18,
  },
  merchantInput: {
    color: '#15181c',
    fontSize: 20,
    fontWeight: '800',
    paddingVertical: 2,
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  merchantInputs: {
    flex: 1,
    minWidth: 0,
  },
  dateInput: {
    marginTop: 6,
    color: '#68707a',
    fontSize: 14,
    paddingVertical: 2,
  },
  metricsRow: {
    flexDirection: 'row',
    marginTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#e8ebef',
  },
  metric: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  metricBorder: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: '#e8ebef',
  },
  metricLabel: {
    color: '#747d88',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  metricInput: {
    color: '#15181c',
    fontSize: 16,
    fontWeight: '800',
    paddingVertical: 0,
  },
  noteLabel: {
    marginTop: 14,
    marginBottom: 6,
    color: '#747d88',
    fontSize: 12,
    fontWeight: '700',
  },
  noteInput: {
    minHeight: 56,
    borderRadius: 8,
    backgroundColor: '#f5f7fa',
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#15181c',
    fontSize: 14,
    textAlignVertical: 'top',
  },
});
