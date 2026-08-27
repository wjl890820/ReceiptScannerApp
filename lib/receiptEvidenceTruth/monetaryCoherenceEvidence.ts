/**
 * A1.4A — Receipt monetary coherence evidence (read-only / shadow).
 */

import type { ReceiptRow } from '../db';
import { resolveReceiptMonetarySourceBundle } from '../analysisFoundation/monetarySourceBundle';
import { assessSameLayerMonetaryClosure } from './monetaryClosure';
import type {
  MonetaryCoherenceState,
  ReceiptMonetaryCoherenceEvidence,
} from './types';

function parseAnalysisJson(receipt: ReceiptRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(receipt.analysis_json || '{}');
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readOcrReconciliationFlags(analysis: Record<string, unknown> | null): {
  reconciliationOk: boolean | null;
  amountMismatch: boolean | null;
} {
  if (!analysis) return { reconciliationOk: null, amountMismatch: null };
  let reconciliationOk: boolean | null = null;
  let amountMismatch: boolean | null = null;
  if (typeof analysis.amount_mismatch === 'boolean') {
    amountMismatch = analysis.amount_mismatch;
  }
  const recon = analysis.reconciliation;
  if (recon && typeof recon === 'object' && !Array.isArray(recon)) {
    const ok = (recon as Record<string, unknown>).ok;
    if (typeof ok === 'boolean') reconciliationOk = ok;
  }
  return { reconciliationOk, amountMismatch };
}

export function buildReceiptMonetaryCoherenceEvidence(
  receipt: ReceiptRow
): ReceiptMonetaryCoherenceEvidence {
  const bundle = resolveReceiptMonetarySourceBundle(receipt);
  const analysis = parseAnalysisJson(receipt);
  const ocrFlags = readOcrReconciliationFlags(analysis);

  const closure = assessSameLayerMonetaryClosure(receipt, bundle, ocrFlags);
  let state: MonetaryCoherenceState = closure.state;
  const evidence = [...new Set([...bundle.evidence, ...closure.evidence])].sort();
  const reasonCodes = [
    ...new Set([...bundle.reasonCodes, ...closure.reasonCodes]),
  ].sort();

  let monetaryProvenanceSufficient = state === 'known_coherent';

  if (bundle.discountOwnershipStatus === 'unresolved') {
    monetaryProvenanceSufficient = false;
    if (state === 'known_coherent') {
      state = 'known_incoherent';
    }
    reasonCodes.push('discount_ownership_unresolved');
    reasonCodes.push('insufficient_discount_ownership_evidence');
  }

  return {
    receiptId: receipt.id,
    state,
    authoritativeLayer: bundle.layer,
    discountOwnershipStatus: bundle.discountOwnershipStatus,
    monetaryProvenanceSufficient,
    closureHypothesis: closure.hypothesis,
    evidence,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

export function monetaryCoherenceRank(state: MonetaryCoherenceState): number {
  if (state === 'known_coherent') return 2;
  if (state === 'unknown') return 1;
  return 0;
}
