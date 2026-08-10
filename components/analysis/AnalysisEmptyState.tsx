import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';

type AnalysisEmptyStateProps = {
  variant: 'empty' | 'period_empty';
  onGoHome: () => void;
  onSwitchToAll?: () => void;
};

export function AnalysisEmptyState({
  variant,
  onGoHome,
  onSwitchToAll,
}: AnalysisEmptyStateProps) {
  const isPeriodEmpty = variant === 'period_empty';
  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {t(
          isPeriodEmpty
            ? 'analysis.release.periodEmpty.title'
            : 'analysis.release.empty.title'
        )}
      </Text>
      <Text style={styles.subtitle}>
        {t(
          isPeriodEmpty
            ? 'analysis.release.periodEmpty.subtitle'
            : 'analysis.release.empty.subtitle'
        )}
      </Text>
      {isPeriodEmpty && onSwitchToAll ? (
        <Pressable
          onPress={onSwitchToAll}
          accessibilityRole="button"
          accessibilityLabel={t('analysis.release.periodEmpty.switchAll')}
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryBtnText}>
            {t('analysis.release.periodEmpty.switchAll')}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={onGoHome}
        accessibilityRole="button"
        accessibilityLabel={t('analysis.release.empty.cta')}
        style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
      >
        <Text style={styles.primaryBtnText}>
          {t('analysis.release.empty.cta')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 18,
    padding: 20,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
    backgroundColor: '#fff',
  },
  title: {
    color: '#15181c',
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 24,
  },
  subtitle: {
    marginTop: 8,
    color: '#68707a',
    fontSize: 14,
    lineHeight: 21,
  },
  primaryBtn: {
    marginTop: 18,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#1677ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryBtn: {
    marginTop: 16,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cfe1fb',
    backgroundColor: '#f5f9ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: {
    color: '#1677ff',
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.75,
  },
});
