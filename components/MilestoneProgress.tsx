import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';
import type { PostSaveMilestoneViewModel } from '@/lib/milestonePresentation';

export function MilestoneProgress({
  viewModel,
}: {
  viewModel: PostSaveMilestoneViewModel;
}) {
  if (!viewModel.showProgress || viewModel.supportedReceiptCount == null) {
    return null;
  }
  if (viewModel.profileEstablished) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>
          {t('postSaveSummary.progress.profileEstablished')}
        </Text>
      </View>
    );
  }
  if (
    viewModel.nextMilestone == null ||
    viewModel.receiptsUntilNext == null
  ) {
    return null;
  }
  const ratio = Math.min(
    1,
    viewModel.supportedReceiptCount / viewModel.nextMilestone
  );
  const unlockKey =
    viewModel.nextMilestone === 3
      ? 'postSaveSummary.progress.unlockRecent'
      : viewModel.nextMilestone === 5
        ? 'postSaveSummary.progress.unlockFrequent'
        : 'postSaveSummary.progress.unlockProfile';

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title}>{t('postSaveSummary.progress.title')}</Text>
        <Text style={styles.count}>
          {viewModel.supportedReceiptCount} / {viewModel.nextMilestone}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${ratio * 100}%` }]} />
      </View>
      <Text style={styles.hint}>
        {t(unlockKey, { count: viewModel.receiptsUntilNext })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 18,
    padding: 16,
    borderRadius: 14,
    backgroundColor: '#f3f3f3',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: '#222',
    fontSize: 14,
    fontWeight: '700',
  },
  count: {
    color: '#222',
    fontSize: 14,
    fontWeight: '800',
  },
  track: {
    height: 7,
    marginTop: 12,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#ddd',
  },
  fill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#222',
  },
  hint: {
    marginTop: 10,
    color: '#666',
    fontSize: 13,
    lineHeight: 19,
  },
});
