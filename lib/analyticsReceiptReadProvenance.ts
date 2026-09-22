/**
 * Analytics receipt-read generation provenance (Slice 3D.2).
 *
 * Captures the authoritative analytics generation BEFORE an async receipt read
 * and validates it AFTER. Stale rows must never be relabeled with a newer
 * generation.
 *
 * Neutral module — does not import Home / Product Detail.
 */

import { getAnalyticsReceiptSelectionDataGeneration } from './analyticsReceiptSelectionCache';

export class AnalyticsGenerationStaleError extends Error {
  readonly stale = true as const;

  constructor(message = 'analytics generation drifted during receipt read') {
    super(message);
    this.name = 'AnalyticsGenerationStaleError';
  }
}

export function isAnalyticsGenerationStaleError(
  error: unknown
): error is AnalyticsGenerationStaleError {
  return (
    error instanceof AnalyticsGenerationStaleError ||
    (typeof error === 'object' &&
      error != null &&
      (error as { name?: string; stale?: unknown }).name ===
        'AnalyticsGenerationStaleError' &&
      (error as { stale?: unknown }).stale === true)
  );
}

export type ReadWithAnalyticsGenerationResult<T> =
  | {
      ok: true;
      value: T;
      analyticsGeneration: number;
    }
  | {
      ok: false;
      stale: true;
    };

/**
 * Capture generation before `asyncRead`, validate after.
 * On drift: ok=false (rows must not be tagged with the new generation).
 */
export async function readWithAnalyticsGeneration<T>(
  asyncRead: () => Promise<T> | T
): Promise<ReadWithAnalyticsGenerationResult<T>> {
  const analyticsGeneration = getAnalyticsReceiptSelectionDataGeneration();
  const value = await Promise.resolve(asyncRead());
  if (getAnalyticsReceiptSelectionDataGeneration() !== analyticsGeneration) {
    return { ok: false, stale: true };
  }
  return { ok: true, value, analyticsGeneration };
}

/** True when caller-held generation still matches live authority. */
export function isLiveAnalyticsGeneration(
  analyticsGeneration: number
): boolean {
  return (
    analyticsGeneration === getAnalyticsReceiptSelectionDataGeneration()
  );
}

export function assertLiveAnalyticsGeneration(
  analyticsGeneration: number,
  phase: string
): void {
  if (!isLiveAnalyticsGeneration(analyticsGeneration)) {
    throw new AnalyticsGenerationStaleError(
      `analytics generation drifted (${phase})`
    );
  }
}
