import React from 'react';
import { StyleSheet, View } from 'react-native';

import { MerunoText } from '@/components/primitives/MerunoText';
import type { EngagementMilestoneStatus } from '@/lib/engagementMilestones';
import { t } from '@/lib/i18n';
import { milestoneProgressVisual } from '@/lib/milestoneProgressVisual';

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
      <View style={milestoneProgressVisual.card}>
        <MerunoText role="bodySmall" tone="primary" style={styles.title}>
          {t('home.progressive.progress.profileEstablished')}
        </MerunoText>
        <MerunoText role="meta" tone="secondary" style={styles.profileHint}>
          {t('home.progressive.progress.profileEstablishedHint')}
        </MerunoText>
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
    <View style={milestoneProgressVisual.card}>
      <View style={styles.row}>
        <MerunoText role="bodySmall" tone="primary" style={styles.title}>
          {t('home.progressive.progress.title')}
        </MerunoText>
        <MerunoText
          role="bodySmall"
          tone="accent"
          style={styles.count}
        >
          {status.supportedReceiptCount} / {status.nextMilestone}
        </MerunoText>
      </View>
      <View style={[milestoneProgressVisual.track, styles.track]}>
        <View style={[milestoneProgressVisual.fill, { width: `${ratio * 100}%` }]} />
      </View>
      <MerunoText role="meta" tone="secondary" style={styles.hint}>
        {t(hintKey, { count: status.receiptsUntilNext })}
      </MerunoText>
    </View>
  );
}

const styles = StyleSheet.create({
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
    marginTop: 13,
  },
  hint: {
    marginTop: 10,
  },
  profileHint: {
    marginTop: 10,
  },
});
