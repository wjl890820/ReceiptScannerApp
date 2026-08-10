import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';
import type { EngagementMilestoneStatus } from '@/lib/engagementMilestones';

export function MilestoneProgressCard({
  status,
}: {
  status: EngagementMilestoneStatus;
}) {
  if (
    status.nextMilestone == null ||
    status.receiptsUntilNext == null
  ) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>
          {t('home.progressive.progress.profileEstablished')}
        </Text>
        <Text style={styles.subtitle}>
          {t('home.progressive.progress.profileEstablishedHint')}
        </Text>
      </View>
    );
  }
  const ratio = Math.min(
    1,
    status.supportedReceiptCount / status.nextMilestone
  );
  const hintKey =
    status.nextMilestone === 3
      ? 'home.progressive.progress.unlockRecent'
      : status.nextMilestone === 5
        ? 'home.progressive.progress.unlockFrequent'
        : 'home.progressive.progress.unlockProfile';

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title}>{t('home.progressive.progress.title')}</Text>
        <Text style={styles.count}>
          {status.supportedReceiptCount} / {status.nextMilestone}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${ratio * 100}%` }]} />
      </View>
      <Text style={styles.subtitle}>
        {t(hintKey, { count: status.receiptsUntilNext })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
    backgroundColor: '#fff',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: '#16181b',
    fontSize: 15,
    fontWeight: '700',
  },
  count: {
    color: '#1677ff',
    fontSize: 15,
    fontWeight: '800',
  },
  track: {
    height: 7,
    marginTop: 13,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#e9edf2',
  },
  fill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#1677ff',
  },
  subtitle: {
    marginTop: 10,
    color: '#68707a',
    fontSize: 13,
    lineHeight: 19,
  },
});
