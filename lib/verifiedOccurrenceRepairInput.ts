/**
 * Operator paste parser for exact-ID verified occurrence repair.
 * Blank lines are ignored. IDs are not trimmed into a different identity.
 */

import { assertExactVerifiedOccurrenceReceiptIds } from './verifiedPurchaseOccurrenceDryRun';
import { VerifiedPurchaseOccurrenceDryRunError } from './verifiedPurchaseOccurrenceDryRun';

export const VERIFIED_OCCURRENCE_REPAIR_MAX_RECEIPT_IDS = 100;

export type ParsedVerifiedOccurrenceRepairIds =
  | { ok: true; receiptIds: string[] }
  | {
      ok: false;
      reason: 'invalid_id' | 'duplicate' | 'too_few' | 'too_many';
    };

export function parseVerifiedOccurrenceRepairIdInput(
  raw: string
): ParsedVerifiedOccurrenceRepairIds {
  const lines = raw.split(/\r?\n/);
  const ids: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line !== line.trim()) {
      return { ok: false, reason: 'invalid_id' };
    }
    ids.push(line);
  }
  if (ids.length > VERIFIED_OCCURRENCE_REPAIR_MAX_RECEIPT_IDS) {
    return { ok: false, reason: 'too_many' };
  }
  try {
    return {
      ok: true,
      receiptIds: assertExactVerifiedOccurrenceReceiptIds(ids),
    };
  } catch (error) {
    if (error instanceof VerifiedPurchaseOccurrenceDryRunError) {
      if (/duplicate/i.test(error.message)) return { ok: false, reason: 'duplicate' };
      if (/at least two/i.test(error.message)) return { ok: false, reason: 'too_few' };
    }
    return { ok: false, reason: 'invalid_id' };
  }
}

export const VERIFIED_OCCURRENCE_REPAIR_CONFIRM_MESSAGE =
  'The receipt records will not be deleted.';

export function verifiedOccurrenceRepairConfirmMessage(count: number): string {
  return `This will mark ${count} stored receipt observations as one user-verified physical purchase. ${VERIFIED_OCCURRENCE_REPAIR_CONFIRM_MESSAGE}`;
}

export function verifiedOccurrenceRepairVerificationFailureMessage(): string {
  return 'Local verification failed. The local assignment is already committed and was not rolled back.';
}

export function verifiedOccurrenceRepairCloudRequestFailureMessage(): string {
  return 'Local assignment succeeded and was not rolled back. Cloud sync request failed; durable outbox remains queued/retryable.';
}

/** Assign stays off unless the latest dry run matches the current text. */
export function isVerifiedOccurrenceRepairAssignEnabled(input: {
  draftText: string;
  previewDraftText: string | null;
  executionAllowed: boolean;
}): boolean {
  if (!input.executionAllowed || input.previewDraftText == null) return false;
  return input.draftText === input.previewDraftText;
}
