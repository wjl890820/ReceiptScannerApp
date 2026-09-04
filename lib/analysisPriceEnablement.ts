/**
 * AP-3 Analysis enablement helper (dormant until flag flips).
 * Keeps loader/scheduler imports out of the Analysis screen module text
 * while the release gate remains false.
 *
 * RN InteractionManager runs here (not in the Jest-loaded scheduler) so
 * Analysis can paint before AP-3 CPU work begins.
 */

import { InteractionManager } from 'react-native';

import type { ReceiptRow } from './db';
import type { AnalysisPriceChangesSurface } from './analysisPriceSurfaces';
import { loadAnalysisTrustedPriceChangesSurface } from './analysisPriceLoader';
import {
  createAnalysisPriceFocusToken,
  createAnalysisPriceGeneration,
  type AnalysisPriceFocusToken,
  type AnalysisPriceGeneration,
} from './analysisPriceScheduler';

export type ScheduledAnalysisPriceLoad = {
  promise: Promise<AnalysisPriceChangesSurface | null>;
  cancel: () => void;
  generation: AnalysisPriceGeneration;
  focusToken: AnalysisPriceFocusToken;
};

function waitForInteractionsCancellable(): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let settled = false;
  let resolveFn: (() => void) | null = null;
  let handle: { cancel?: () => void } | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveFn = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const task = InteractionManager.runAfterInteractions(() => {
      resolveFn?.();
    });
    handle = task as { cancel?: () => void };
  });
  return {
    promise,
    cancel: () => {
      handle?.cancel?.();
      resolveFn?.();
    },
  };
}

/**
 * Schedule AP-3 load after interactions + first-paint deferral.
 * Cancel on Analysis blur before start → derivation never begins.
 */
export function scheduleAnalysisPriceLoadAfterPaint(input: {
  analyticsReceipts: readonly ReceiptRow[];
  isStale: () => boolean;
  focusToken?: AnalysisPriceFocusToken;
}): ScheduledAnalysisPriceLoad {
  const generation = createAnalysisPriceGeneration();
  const focusToken = input.focusToken ?? createAnalysisPriceFocusToken();
  let canceled = false;
  const interaction = waitForInteractionsCancellable();

  const isStaleNow = () =>
    canceled ||
    input.isStale() ||
    !focusToken.isActive() ||
    generation.isCanceled();

  const promise = (async (): Promise<AnalysisPriceChangesSurface | null> => {
    await interaction.promise;
    if (isStaleNow()) return null;
    const surface = await loadAnalysisTrustedPriceChangesSurface(
      input.analyticsReceipts,
      {
        generation,
        focusToken,
        shouldCancel: isStaleNow,
        deferUntilPaint: true,
      }
    );
    if (isStaleNow()) return null;
    return surface;
  })();

  return {
    promise,
    generation,
    focusToken,
    cancel: () => {
      canceled = true;
      focusToken.cancel();
      generation.cancel();
      interaction.cancel();
    },
  };
}

/** @deprecated Prefer scheduleAnalysisPriceLoadAfterPaint for blur cancellation. */
export async function runAnalysisPriceLoadAfterPaint(input: {
  analyticsReceipts: readonly ReceiptRow[];
  isStale: () => boolean;
}): Promise<AnalysisPriceChangesSurface | null> {
  const scheduled = scheduleAnalysisPriceLoadAfterPaint(input);
  return scheduled.promise;
}
