/**
 * Verified purchase occurrence provenance — pure bundle model (A2.1 / A2.1a / A2.1b).
 * Dependency-light: no db.ts / ReceiptRow imports.
 *
 * Bundle invariant: all-null (unassigned) XOR all-valid (assigned).
 * Partial / malformed explicit provenance is invalid — never collapse to unassigned.
 */

export const VERIFIED_PURCHASE_OCCURRENCE_SOURCES = [
  'research_verified',
  'user_verified',
  'support_verified',
] as const;

export type VerifiedPurchaseOccurrenceSource =
  (typeof VERIFIED_PURCHASE_OCCURRENCE_SOURCES)[number];

export const VERIFIED_PURCHASE_OCCURRENCE_ID_PREFIX = 'vpo_' as const;
export const VERIFIED_PURCHASE_OCCURRENCE_ID_MAX_LEN = 128;

/**
 * Max durable verified-at audit epoch ms: 9999-12-31T23:59:59.999Z.
 * Aligns local classification, assignment, backup ISO, cloud parser, and migration CHECK.
 * Four-digit years only — no extended-year (+010000-…) serialization.
 */
export const MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS = 253_402_300_799_999;

/** @deprecated Use MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS. */
export const MAX_DURABLE_EPOCH_MS = MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS;

export type VerifiedPurchaseOccurrenceProvenance = {
  occurrenceId: string;
  source: VerifiedPurchaseOccurrenceSource;
  /** Epoch milliseconds — verification/audit time, not purchase time. */
  verifiedAt: number;
};

export type VerifiedPurchaseOccurrenceState =
  | { state: 'unassigned' }
  | { state: 'assigned'; value: VerifiedPurchaseOccurrenceProvenance }
  | { state: 'invalid'; reason: string };

export type RawVerifiedPurchaseOccurrenceBundle = {
  occurrenceId?: unknown;
  source?: unknown;
  verifiedAt?: unknown;
};

function isBlankish(value: unknown): boolean {
  return value === null || value === undefined;
}

export function isVerifiedPurchaseOccurrenceSource(
  value: unknown
): value is VerifiedPurchaseOccurrenceSource {
  return (
    typeof value === 'string' &&
    (VERIFIED_PURCHASE_OCCURRENCE_SOURCES as readonly string[]).includes(value)
  );
}

export function isValidVerifiedPurchaseOccurrenceId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed !== value) return false; // no surrounding whitespace
  if (trimmed.length === 0) return false;
  if (trimmed.length > VERIFIED_PURCHASE_OCCURRENCE_ID_MAX_LEN) return false;
  return true;
}

/**
 * Durable local epoch-ms contract for verified_at / nowMs / client_updated_at.
 * Finite, positive, ≤ 9999-12-31T23:59:59.999Z, and ISO-safe.
 */
export function isDurableEpochMs(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (!Number.isFinite(value)) return false;
  if (value <= 0) return false;
  if (value > MAX_VERIFIED_PURCHASE_OCCURRENCE_EPOCH_MS) return false;
  try {
    const iso = new Date(value).toISOString();
    return typeof iso === 'string' && iso.length > 0;
  } catch {
    return false;
  }
}

/** @deprecated Prefer isDurableEpochMs — kept as alias for local verified_at checks. */
export function isValidVerifiedAtMs(value: unknown): value is number {
  return isDurableEpochMs(value);
}

function generateOpaqueIdSuffix(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID().replace(/-/g, '');
    }
  } catch {
    // fall through
  }
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () =>
    ((Math.random() * 16) | 0).toString(16)
  );
}

/** Opaque durable group id — never derived from merchant/date/amount/basket. */
export function generateVerifiedPurchaseOccurrenceId(): string {
  return `${VERIFIED_PURCHASE_OCCURRENCE_ID_PREFIX}${generateOpaqueIdSuffix()}`;
}

/**
 * Classify a raw persisted / cloud verified-occurrence bundle.
 * Presence of any non-null field with incomplete siblings → invalid.
 */
export function classifyVerifiedPurchaseOccurrenceBundle(
  raw: RawVerifiedPurchaseOccurrenceBundle
): VerifiedPurchaseOccurrenceState {
  const idBlank = isBlankish(raw.occurrenceId);
  const sourceBlank = isBlankish(raw.source);
  const atBlank = isBlankish(raw.verifiedAt);

  if (idBlank && sourceBlank && atBlank) {
    return { state: 'unassigned' };
  }

  if (idBlank || sourceBlank || atBlank) {
    return {
      state: 'invalid',
      reason: 'incomplete_verified_purchase_occurrence_bundle',
    };
  }

  if (!isValidVerifiedPurchaseOccurrenceId(raw.occurrenceId)) {
    return {
      state: 'invalid',
      reason: 'malformed_verified_purchase_occurrence_id',
    };
  }
  if (!isVerifiedPurchaseOccurrenceSource(raw.source)) {
    return {
      state: 'invalid',
      reason: 'unsupported_verified_purchase_occurrence_source',
    };
  }
  if (!isDurableEpochMs(raw.verifiedAt)) {
    return {
      state: 'invalid',
      reason: 'malformed_verified_purchase_occurrence_verified_at',
    };
  }

  return {
    state: 'assigned',
    value: {
      occurrenceId: raw.occurrenceId,
      source: raw.source,
      verifiedAt: raw.verifiedAt,
    },
  };
}

/**
 * Strict PostgREST / Supabase TIMESTAMPTZ string → epoch ms.
 * Requires typeof === 'string' and four-digit-year ISO/RFC3339 machine form.
 * Never coerces via String(raw). Never treats "" / whitespace as absence.
 */
const CLOUD_TIMESTAMPTZ_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}(?::?\d{2})?)$/;

export function parseVerifiedPurchaseOccurrenceCloudTimestamp(
  raw: unknown
): number {
  if (typeof raw !== 'string') {
    throw new Error(
      'verified_purchase_occurrence_verified_at must be an ISO timestamptz string'
    );
  }
  // Explicit empty / whitespace-only strings are present-but-malformed, not absent.
  if (raw.length === 0 || raw.trim().length === 0 || raw.trim() !== raw) {
    throw new Error(
      'malformed verified_purchase_occurrence_verified_at'
    );
  }
  if (!CLOUD_TIMESTAMPTZ_RE.test(raw)) {
    throw new Error(
      'malformed verified_purchase_occurrence_verified_at'
    );
  }
  const ms = Date.parse(raw);
  if (!isDurableEpochMs(ms)) {
    throw new Error(
      'malformed verified_purchase_occurrence_verified_at'
    );
  }
  return ms;
}

/**
 * null / undefined → null (absent / unassigned field).
 * Any present string (including "" / "   ") → strict parse (throws if malformed).
 */
export function cloudVerifiedAtToMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  return parseVerifiedPurchaseOccurrenceCloudTimestamp(raw);
}

export function verifiedAtMsToIso(ms: number): string {
  if (!isDurableEpochMs(ms)) {
    throw new Error('verified_at is not a durable epoch millisecond');
  }
  return new Date(ms).toISOString();
}
