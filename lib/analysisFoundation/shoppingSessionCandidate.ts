/**
 * A1 — Shopping session candidates (read-only, never confirmed).
 *
 * Temporal proximity is evidence only — not proof of one shopping trip.
 * A1.1: requires exact transaction clock time (date_only excluded);
 * anti-chaining via maxSessionSpanMinutes in addition to adjacent gaps.
 */

import type { ReceiptRow } from '../db';
import {
  hasExactTransactionTime,
  hasValidTransactionAt,
} from '../analysisDDuplicateAudit';
import { merchantAnalyticsKey } from '../merchantAnalytics';
import type {
  ShoppingSessionCandidate,
  ShoppingSessionCandidateConfig,
} from './types';
import { DEFAULT_SHOPPING_SESSION_CANDIDATE_CONFIG } from './types';

function tokyoDayKey(ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const y = parts.find((p) => p.type === 'year')?.value ?? '';
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const d = parts.find((p) => p.type === 'day')?.value ?? '';
    return `${y}-${m}-${d}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

type TimedReceipt = {
  receipt: ReceiptRow;
  at: number;
  dayKey: string;
  merchantKey: string;
};

/**
 * Only exact_time receipts participate in shopping-session proximity.
 * date_only (valid calendar date but midnight) is excluded.
 */
function eligibleTimedReceipts(receipts: ReceiptRow[]): TimedReceipt[] {
  const out: TimedReceipt[] = [];
  for (const receipt of receipts) {
    if (!hasValidTransactionAt(receipt)) continue;
    if (!hasExactTransactionTime(receipt)) continue;
    const at = receipt.transaction_at as number;
    out.push({
      receipt,
      at,
      dayKey: tokyoDayKey(at),
      merchantKey: merchantAnalyticsKey(receipt),
    });
  }
  out.sort((a, b) => a.at - b.at || a.receipt.id.localeCompare(b.receipt.id));
  return out;
}

function gapMinutes(a: TimedReceipt, b: TimedReceipt): number {
  return Math.abs(b.at - a.at) / 60_000;
}

function spanMinutes(first: TimedReceipt, last: TimedReceipt): number {
  return Math.abs(last.at - first.at) / 60_000;
}

function buildCandidateCluster(
  cluster: TimedReceipt[],
  config: ShoppingSessionCandidateConfig
): ShoppingSessionCandidate | null {
  if (cluster.length < 2) return null;

  const receiptIds = cluster.map((c) => c.receipt.id);
  const merchantKeys = [...new Set(cluster.map((c) => c.merchantKey))].sort();
  const startAt = cluster[0]!.at;
  const endAt = cluster[cluster.length - 1]!.at;

  const gaps: number[] = [];
  for (let i = 1; i < cluster.length; i++) {
    gaps.push(gapMinutes(cluster[i - 1]!, cluster[i]!));
  }
  const maxGap = Math.max(...gaps);
  const minGap = Math.min(...gaps);
  const totalSpan = spanMinutes(cluster[0]!, cluster[cluster.length - 1]!);

  const evidence: string[] = [
    'shopping_session_candidate_only_not_confirmed',
    `receipt_count=${cluster.length}`,
    `same_day=${cluster.every((c) => c.dayKey === cluster[0]!.dayKey)}`,
    `merchant_count=${merchantKeys.length}`,
    `max_gap_minutes=${Math.round(maxGap)}`,
    `min_gap_minutes=${Math.round(minGap)}`,
    `session_span_minutes=${Math.round(totalSpan)}`,
  ];

  let confidence: ShoppingSessionCandidate['confidence'] = 'low';
  if (
    maxGap <= config.strongGapMinutes &&
    cluster.every((c) => c.dayKey === cluster[0]!.dayKey)
  ) {
    confidence = merchantKeys.length >= 2 ? 'medium' : 'high';
  } else if (maxGap <= config.adjacentMaxMinutes) {
    confidence = merchantKeys.length >= 2 ? 'medium' : 'low';
  }

  if (merchantKeys.length >= 2) {
    evidence.push('multi_merchant_proximity_evidence_only');
  }

  return {
    status: 'candidate',
    receiptIds,
    startAt,
    endAt,
    merchantKeys,
    confidence,
    evidence,
  };
}

/**
 * Cluster receipts into shopping session candidates using configurable time rules.
 * Requires exact transaction clock time; date_only receipts are excluded.
 * Splits when adjacent gap OR total session span would exceed limits.
 */
export function buildShoppingSessionCandidates(
  receipts: ReceiptRow[],
  config: ShoppingSessionCandidateConfig = DEFAULT_SHOPPING_SESSION_CANDIDATE_CONFIG
): ShoppingSessionCandidate[] {
  const timed = eligibleTimedReceipts(receipts);
  if (timed.length < 2) return [];

  const byDay = new Map<string, TimedReceipt[]>();
  for (const row of timed) {
    const list = byDay.get(row.dayKey) ?? [];
    list.push(row);
    byDay.set(row.dayKey, list);
  }

  const candidates: ShoppingSessionCandidate[] = [];

  for (const [, dayRows] of byDay) {
    if (config.sameCalendarDayRequired === false) {
      // Not used in default config; keep day bucketing for determinism.
    }
    if (dayRows.length < 2) continue;

    let cluster: TimedReceipt[] = [dayRows[0]!];
    for (let i = 1; i < dayRows.length; i++) {
      const prev = dayRows[i - 1]!;
      const cur = dayRows[i]!;
      const gap = gapMinutes(prev, cur);
      const wouldSpan = spanMinutes(cluster[0]!, cur);
      const adjacentOk = gap <= config.adjacentMaxMinutes;
      const spanOk = wouldSpan <= config.maxSessionSpanMinutes;
      if (adjacentOk && spanOk) {
        cluster.push(cur);
      } else {
        const candidate = buildCandidateCluster(cluster, config);
        if (candidate) candidates.push(candidate);
        cluster = [cur];
      }
    }
    const tail = buildCandidateCluster(cluster, config);
    if (tail) candidates.push(tail);
  }

  candidates.sort(
    (a, b) =>
      b.startAt - a.startAt || a.receiptIds[0]!.localeCompare(b.receiptIds[0]!)
  );
  return candidates;
}

/** Receipt ids that appear in any candidate cluster. */
export function receiptIdsInShoppingSessionCandidates(
  candidates: ShoppingSessionCandidate[]
): Set<string> {
  const ids = new Set<string>();
  for (const c of candidates) {
    for (const id of c.receiptIds) ids.add(id);
  }
  return ids;
}
