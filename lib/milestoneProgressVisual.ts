import { StyleSheet } from 'react-native';

import { UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

/** Shared progress-track height across milestone progress presentations. */
export const MILESTONE_PROGRESS_TRACK_HEIGHT = 7;

/**
 * Visual-only styles shared by MilestoneProgressCard and MilestoneProgress.
 * No milestone domain types — presentation contract only.
 */
export const milestoneProgressVisual = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: UI_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surface,
  },
  track: {
    height: MILESTONE_PROGRESS_TRACK_HEIGHT,
    borderRadius: UI_RADIUS.pill,
    overflow: 'hidden',
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  fill: {
    height: '100%',
    borderRadius: UI_RADIUS.pill,
    backgroundColor: UI_COLORS.accent,
  },
});
