/**
 * Effective receipt tax provenance (read-only).
 *
 * Persisted tax_is_known=1 is authoritative.
 * Legacy rows (column default 0 / early writers) may recover trust only when
 * production resolveReceiptTax(analysis_json) confirms the same positive tax.
 *
 * recognition_snapshot_json is NEVER product authority.
 *
 * Sharing across amountBasis + monetary closure uses a module-issued,
 * receipt-input-bound opaque token — plain POJO decisions are not reusable
 * trust capabilities.
 */

import type { ReceiptRow } from '../db';
import * as receiptOcrNormalize from '../receiptOcrNormalize';
import type { ReceiptAnalysis } from '../receiptAnalyzer';
import type { TaxProvenanceTrust } from './types';

export type EffectiveTaxProvenanceSource =
  | 'persisted_known'
  | 'legacy_analysis_recovered'
  | 'untrusted';

/** Readable semantic decision — NOT a reusable trust capability. */
export type EffectiveReceiptTaxProvenance = {
  trust: TaxProvenanceTrust;
  source: EffectiveTaxProvenanceSource;
};

/**
 * Opaque, module-issued authority token bound to specific receipt tax inputs.
 * Constructed only by resolveEffectiveReceiptTaxProvenance / resolveOrReuse*.
 * Plain objects / casts are rejected at runtime.
 */
export type BoundEffectiveReceiptTaxProvenance = {
  readonly decision: EffectiveReceiptTaxProvenance;
};

type TaxProvenanceReceiptInputs = Pick<
  ReceiptRow,
  'tax' | 'tax_is_known' | 'analysis_json'
>;

type TaxProvenanceBinding = {
  tax: unknown;
  taxIsKnown: unknown;
  analysisJson: string | null;
};

const ISSUED_BOUNDS = new WeakSet<object>();
const BOUND_INPUTS = new WeakMap<object, TaxProvenanceBinding>();

function captureBinding(receipt: TaxProvenanceReceiptInputs): TaxProvenanceBinding {
  return {
    tax: receipt.tax,
    taxIsKnown: receipt.tax_is_known,
    analysisJson:
      receipt.analysis_json == null ? null : String(receipt.analysis_json),
  };
}

function bindingsMatch(a: TaxProvenanceBinding, b: TaxProvenanceBinding): boolean {
  return (
    Object.is(a.tax, b.tax) &&
    Object.is(a.taxIsKnown, b.taxIsKnown) &&
    a.analysisJson === b.analysisJson
  );
}

function isIssuedBound(
  value: unknown
): value is BoundEffectiveReceiptTaxProvenance {
  return (
    typeof value === 'object' &&
    value != null &&
    ISSUED_BOUNDS.has(value as object)
  );
}

function issueBound(
  receipt: TaxProvenanceReceiptInputs,
  decision: EffectiveReceiptTaxProvenance
): BoundEffectiveReceiptTaxProvenance {
  const token = Object.freeze({
    decision: Object.freeze({ ...decision }),
  }) as BoundEffectiveReceiptTaxProvenance;
  ISSUED_BOUNDS.add(token);
  BOUND_INPUTS.set(token, captureBinding(receipt));
  return token;
}

function parseAnalysisObject(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (raw == null || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function computeEffectiveReceiptTaxProvenanceDecision(
  receipt: TaxProvenanceReceiptInputs
): EffectiveReceiptTaxProvenance {
  if (receipt.tax_is_known === 1) {
    return { trust: 'trusted', source: 'persisted_known' };
  }

  const persistedTax = Number(receipt.tax);
  if (!Number.isFinite(persistedTax) || persistedTax <= 0) {
    return { trust: 'untrusted', source: 'untrusted' };
  }

  const analysisObj = parseAnalysisObject(receipt.analysis_json);
  if (!analysisObj) {
    return { trust: 'untrusted', source: 'untrusted' };
  }

  let resolved;
  try {
    // Fixed production authority — never a mutable/test override.
    resolved = receiptOcrNormalize.resolveReceiptTax(
      analysisObj as ReceiptAnalysis & Record<string, unknown>
    );
  } catch {
    return { trust: 'untrusted', source: 'untrusted' };
  }

  if (!resolved.taxIsKnown) {
    return { trust: 'untrusted', source: 'untrusted' };
  }

  const resolvedTax = Number(resolved.tax);
  if (!Number.isFinite(resolvedTax) || resolvedTax <= 0) {
    return { trust: 'untrusted', source: 'untrusted' };
  }

  // Yen persistence contract — exact rounded equality (no new tolerance).
  if (Math.round(resolvedTax) !== Math.round(persistedTax)) {
    return { trust: 'untrusted', source: 'untrusted' };
  }

  return { trust: 'trusted', source: 'legacy_analysis_recovered' };
}

/**
 * Resolve effective tax provenance for amount-basis / exact comparison.
 * Fast path: tax_is_known===1 → trusted (no analysis parse).
 * Legacy path: parse analysis_json once and re-validate via production resolver.
 *
 * Returns a module-issued bound token (not a forgeable POJO capability).
 */
export function resolveEffectiveReceiptTaxProvenance(
  receipt: TaxProvenanceReceiptInputs
): BoundEffectiveReceiptTaxProvenance {
  const decision = computeEffectiveReceiptTaxProvenanceDecision(receipt);
  return issueBound(receipt, decision);
}

/**
 * Reuse a previously issued bound token only when it is module-issued and its
 * bound tax inputs exactly match the current receipt. Otherwise resolve fresh.
 * Forged / mismatched / absent tokens never grant trust — they only fall back.
 */
export function resolveOrReuseEffectiveReceiptTaxProvenance(
  receipt: TaxProvenanceReceiptInputs,
  maybeBound?: BoundEffectiveReceiptTaxProvenance | null
): BoundEffectiveReceiptTaxProvenance {
  if (isIssuedBound(maybeBound)) {
    const binding = BOUND_INPUTS.get(maybeBound as object);
    if (binding && bindingsMatch(binding, captureBinding(receipt))) {
      return maybeBound;
    }
  }
  return resolveEffectiveReceiptTaxProvenance(receipt);
}
