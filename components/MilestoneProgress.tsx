import React from 'react';
import { StyleSheet, View } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import { t } from '@/lib/i18n';
import type { PostSaveMilestoneViewModel } from '@/lib/milestonePresentation';
import { milestoneProgressVisual } from '@/lib/milestoneProgressVisual';

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
      <View style={[milestoneProgressVisual.card, styles.cardSpacing]}>
        <MerunoText role="chip" tone="primary" style={styles.title}>
          {t('postSaveSummary.progress.profileEstablished')}
        </MerunoText>
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
    <View style={[milestoneProgressVisual.card, styles.cardSpacing]}>
      <View style={styles.row}>
        <MerunoText role="chip" tone="primary" style={styles.title}>
          {t('postSaveSummary.progress.title')}
        </MerunoText>
        <MerunoText role="chip" tone="accent" style={styles.count}>
          {viewModel.supportedReceiptCount} / {viewModel.nextMilestone}
        </MerunoText>
      </View>
      <View style={[milestoneProgressVisual.track, styles.track]}>
        <View style={[milestoneProgressVisual.fill, { width: `${ratio * 100}%` }]} />
      </View>
      <MerunoText role="meta" tone="secondary" style={styles.hint}>
        {t(unlockKey, { count: viewModel.receiptsUntilNext })}
      </MerunoText>
    </View>
  );
}

const styles = StyleSheet.create({
  cardSpacing: {
    marginTop: 18,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontWeight: '700',
  },
  count: {
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  track: {
    marginTop: 12,
  },
  hint: {
    marginTop: 10,
  },
});
