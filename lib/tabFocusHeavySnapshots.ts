/**
 * Clear all tab-focus screen-level heavy snapshots.
 * Call synchronously on authoritative owner/session transitions.
 *
 * Does NOT clear lower domain caches (those are already owner-aware /
 * generation-invalidated separately).
 */

import { clearAnalysisFocusHeavySnapshot } from './analysisFocusHeavySnapshot';
import { clearHistoryFocusHeavySnapshot } from './historyFocusHeavySnapshot';
import { clearHomeFocusHeavySnapshot } from './homeFocusHeavySnapshot';

export function clearTabFocusHeavySnapshots(): void {
  clearHomeFocusHeavySnapshot();
  clearAnalysisFocusHeavySnapshot();
  clearHistoryFocusHeavySnapshot();
}

export function __resetTabFocusHeavySnapshotsForTests(): void {
  clearTabFocusHeavySnapshots();
}
