/**
 * Session cache for analytics receipt selection decisions (duplicate-audit).
 *
 * Caches caller-independent duplicate decisions (excluded IDs + groups + counters).
 * Each caller materializes AnalyticsReceiptSelection from its own receipt array
 * so ordering, projection, and object identity are preserved.
 *
 * Does not change duplicate semantics.
 */

import type {
  AnalyticsReceiptSelection,
  AnalyticsReceiptSelectionDecision,
  AnalyticsReceiptSelectionOpts,
} from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import { logger } from './logger';

/**
 * Lazy-load decision builders so mutation invalidation sites can import
 * this module without pulling the duplicate-audit / expo-sqlite graph.
 */
function runBuildDecision(
  receipts: ReceiptRow[],
  opts?: AnalyticsReceiptSelectionOpts
): AnalyticsReceiptSelectionDecision {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./analyticsReceiptSelection') as typeof import('./analyticsReceiptSelection');
  return mod.buildAnalyticsReceiptSelectionDecision(receipts, opts);
}

function runMaterialize(
  receipts: ReceiptRow[],
  decision: AnalyticsReceiptSelectionDecision
): AnalyticsReceiptSelection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./analyticsReceiptSelection') as typeof import('./analyticsReceiptSelection');
  return mod.materializeAnalyticsReceiptSelection(receipts, decision);
}

function runSelectDirect(
  receipts: ReceiptRow[],
  opts?: AnalyticsReceiptSelectionOpts
): AnalyticsReceiptSelection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./analyticsReceiptSelection') as typeof import('./analyticsReceiptSelection');
  return mod.selectAnalyticsReceipts(receipts, opts);
}

/**
 * Bump when decision payload / duplicate-evidence contract changes.
 * v2 = decision-only cache (no caller receipt arrays).
 */
export const ANALYTICS_RECEIPT_SELECTION_CACHE_VERSION =
  'meruno-analytics-receipt-selection-decision-v2' as const;

export type AnalyticsReceiptSelectionInvalidationReason =
  | 'receipt_saved'
  | 'receipt_updated'
  | 'receipt_deleted'
  | 'receipts_cleared'
  | 'cloud_restore'
  | 'ownership_adoption'
  | 'category_backfill'
  | 'receipt_item_index'
  | 'test_reset';

type CacheEntry = {
  key: string;
  decision: AnalyticsReceiptSelectionDecision;
};

let dataGeneration = 0;
const entries = new Map<string, CacheEntry>();
let inFlight: {
  key: string;
  promise: Promise<AnalyticsReceiptSelectionDecision>;
} | null = null;
let underlyingBuildCount = 0;

export function getAnalyticsReceiptSelectionDataGeneration(): number {
  return dataGeneration;
}

export function getAnalyticsReceiptSelectionBuildCount(): number {
  return underlyingBuildCount;
}

export function __resetAnalyticsReceiptSelectionCacheForTests(): void {
  dataGeneration = 0;
  entries.clear();
  inFlight = null;
  underlyingBuildCount = 0;
}

/**
 * Order-independent membership signature (IDs only — not content).
 * Content freshness is carried by dataGeneration invalidation.
 *
 * Duplicate-evidence fields consumed by summarizeReceiptForDuplicateAudit /
 * representative scoring (must be present & equivalent across sharing callers):
 * id, created_at, transaction_at, merchant_raw, merchant_normalized, total,
 * tax, tax_is_known, currency, analysis_json, user_items_json, user_edited,
 * final_total, note.
 * Non-evidence projection diffs (image_uri, final_category, …) are OK because
 * decisions do not retain caller objects — callers rematerialize.
 */
export function buildAnalyticsReceiptSetSignature(
  receipts: readonly { id: string }[]
): string {
  if (receipts.length === 0) return 'n=0';
  const ids = receipts.map((r) => r.id).sort((a, b) => a.localeCompare(b));
  return `n=${ids.length}|${ids.join('\u001f')}`;
}

function keepSeparateSignature(
  keep: ReadonlySet<string> | undefined
): string {
  if (!keep || keep.size === 0) return 'ks=0';
  return `ks=${[...keep].sort((a, b) => a.localeCompare(b)).join('\u001f')}`;
}

export function buildAnalyticsReceiptSelectionCacheKey(input: {
  ownerKey: string;
  dataGeneration: number;
  setSignature: string;
  keepSeparateSignature: string;
  cacheVersion?: string;
}): string {
  return [
    `o=${input.ownerKey}`,
    `g=${input.dataGeneration}`,
    `v=${input.cacheVersion ?? ANALYTICS_RECEIPT_SELECTION_CACHE_VERSION}`,
    `set=${input.setSignature}`,
    input.keepSeparateSignature,
  ].join('|');
}

export function invalidateAnalyticsReceiptSelection(
  reason: AnalyticsReceiptSelectionInvalidationReason | string
): void {
  dataGeneration += 1;
  entries.clear();
  inFlight = null;
  logger.info(
    'AnalyticsSelectionPerf',
    `invalidated reason=${reason} generation=${dataGeneration}`
  );
}

export function logAnalyticsReceiptSelectionPerf(input: {
  decisionCache: 'HIT' | 'MISS' | 'JOIN' | 'SKIP';
  durationMs: number;
  receiptCount?: number;
  generation?: number;
}): void {
  const parts = [
    `decisionCache=${input.decisionCache}`,
    `durationMs=${input.durationMs}`,
  ];
  if (input.generation != null) parts.push(`generation=${input.generation}`);
  if (input.receiptCount != null) parts.push(`receiptCount=${input.receiptCount}`);
  logger.info('AnalyticsSelectionPerf', parts.join(' '));
}

function resolveCacheKey(input: {
  ownerKey: string;
  receipts: ReceiptRow[];
  opts?: AnalyticsReceiptSelectionOpts;
}): { ownerKey: string; key: string; generation: number } {
  const ownerKey = input.ownerKey.trim();
  const setSignature = buildAnalyticsReceiptSetSignature(input.receipts);
  const ks = keepSeparateSignature(input.opts?.keepSeparateReceiptIds);
  const generation = dataGeneration;
  const key = buildAnalyticsReceiptSelectionCacheKey({
    ownerKey,
    dataGeneration: generation,
    setSignature,
    keepSeparateSignature: ks,
  });
  return { ownerKey, key, generation };
}

/**
 * Get or build a shared decision, then materialize against the caller's receipts.
 */
export function selectAnalyticsReceiptsCached(input: {
  ownerKey: string;
  receipts: ReceiptRow[];
  opts?: AnalyticsReceiptSelectionOpts;
  /** When true before MISS build starts, return null without building. */
  shouldSkipExpensiveBuild?: () => boolean;
}): AnalyticsReceiptSelection | null {
  const started = Date.now();
  const ownerKey = input.ownerKey.trim();
  if (!ownerKey) {
    return runSelectDirect(input.receipts, input.opts);
  }

  const { key, generation } = resolveCacheKey(input);
  const hit = entries.get(key);
  if (hit) {
    logAnalyticsReceiptSelectionPerf({
      decisionCache: 'HIT',
      durationMs: Date.now() - started,
      receiptCount: input.receipts.length,
      generation,
    });
    return runMaterialize(input.receipts, hit.decision);
  }

  if (input.shouldSkipExpensiveBuild?.()) {
    logAnalyticsReceiptSelectionPerf({
      decisionCache: 'SKIP',
      durationMs: Date.now() - started,
      receiptCount: input.receipts.length,
      generation,
    });
    return null;
  }

  try {
    const decision = runBuildDecision(input.receipts, input.opts);
    if (dataGeneration === generation) {
      entries.set(key, { key, decision });
      underlyingBuildCount += 1;
    }
    logAnalyticsReceiptSelectionPerf({
      decisionCache: 'MISS',
      durationMs: Date.now() - started,
      receiptCount: input.receipts.length,
      generation,
    });
    return runMaterialize(input.receipts, decision);
  } catch (error) {
    throw error;
  }
}

/**
 * Async wrapper with in-flight JOIN for equivalent decision keys.
 * JOIN shares the decision build; each caller still materializes locally.
 */
export async function selectAnalyticsReceiptsCachedAsync(input: {
  ownerKey: string;
  receipts: ReceiptRow[];
  opts?: AnalyticsReceiptSelectionOpts;
  shouldSkipExpensiveBuild?: () => boolean;
}): Promise<AnalyticsReceiptSelection | null> {
  const started = Date.now();
  const ownerKey = input.ownerKey.trim();
  if (!ownerKey) {
    return runSelectDirect(input.receipts, input.opts);
  }

  const { key, generation } = resolveCacheKey(input);
  const hit = entries.get(key);
  if (hit) {
    logAnalyticsReceiptSelectionPerf({
      decisionCache: 'HIT',
      durationMs: Date.now() - started,
      receiptCount: input.receipts.length,
      generation,
    });
    return runMaterialize(input.receipts, hit.decision);
  }

  if (inFlight && inFlight.key === key) {
    const decision = await inFlight.promise;
    logAnalyticsReceiptSelectionPerf({
      decisionCache: 'JOIN',
      durationMs: Date.now() - started,
      receiptCount: input.receipts.length,
      generation,
    });
    return runMaterialize(input.receipts, decision);
  }

  if (input.shouldSkipExpensiveBuild?.()) {
    logAnalyticsReceiptSelectionPerf({
      decisionCache: 'SKIP',
      durationMs: Date.now() - started,
      receiptCount: input.receipts.length,
      generation,
    });
    return null;
  }

  const promise = (async () => {
    try {
      const decision = runBuildDecision(input.receipts, input.opts);
      if (dataGeneration === generation) {
        entries.set(key, { key, decision });
        underlyingBuildCount += 1;
      }
      logAnalyticsReceiptSelectionPerf({
        decisionCache: 'MISS',
        durationMs: Date.now() - started,
        receiptCount: input.receipts.length,
        generation,
      });
      return decision;
    } finally {
      if (inFlight?.key === key) inFlight = null;
    }
  })();

  inFlight = { key, promise };
  const decision = await promise;
  return runMaterialize(input.receipts, decision);
}
