/**
 * P0 Phase 2 — OCR request provenance (pure helpers + cloud persistence).
 * Does not alter OCR analysis semantics; additive metadata only.
 */

export type OcrDateVerificationProvenance = {
  /** Whether date verification ran during THIS request (false on cache hits). */
  used?: boolean | null;
  model?: string | null;
  /** Origin primary OCR date — null when unknown (e.g. cache hit). */
  primaryTransactionDate?: string | null;
  /** Verifier output — null when verifier did not run or origin unknown. */
  verifiedTransactionDate?: string | null;
  finalTransactionDate?: string | null;
  verifierSucceeded?: boolean | null;
};

export type OcrProvenance = {
  requestId: string;
  primaryModel: string;
  cacheVersion: number;
  cached: boolean;
  imageContentHash?: string;
  dateVerification: OcrDateVerificationProvenance;
};

export type OcrRunInsertRow = {
  request_id: string;
  user_id: string;
  primary_model: string;
  cache_version: number;
  cached: boolean;
  image_content_hash: string | null;
  date_verification_used: boolean | null;
  date_verify_model: string | null;
  primary_transaction_date: string | null;
  verified_transaction_date: string | null;
  final_transaction_date: string | null;
  verifier_succeeded: boolean | null;
};

export type FreshRunProvenanceInput = {
  requestId: string;
  primaryModel: string;
  dateVerifyModel: string;
  cacheVersion: number;
  imageContentHash: string;
  verificationRequired: boolean;
  verifierCalled: boolean;
  verifierCallSucceeded: boolean;
  primaryDate?: string | null;
  verifierDate?: string | null;
  finalTransactionDate?: string | null | undefined;
};

export type CacheHitProvenanceInput = {
  requestId: string;
  primaryModel: string;
  cacheVersion: number;
  imageContentHash: string;
  /** Final analysis from cache (may include transactionDate). */
  cachedAnalysis: { transactionDate?: string | null };
};

export type ProvenanceFeatureFlags = {
  responseEnabled: boolean;
  writeEnabled: boolean;
};

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function parseProvenanceFeatureFlags(env: {
  OCR_PROVENANCE_RESPONSE?: string;
  OCR_PROVENANCE_WRITE?: string;
}): ProvenanceFeatureFlags {
  const readFlag = (key: 'OCR_PROVENANCE_RESPONSE' | 'OCR_PROVENANCE_WRITE', defaultOn: boolean) => {
    const raw = env[key];
    if (raw == null || raw === '') return defaultOn;
    return TRUTHY.has(raw.trim().toLowerCase());
  };
  return {
    // Additive response metadata is safe by default.
    responseEnabled: readFlag('OCR_PROVENANCE_RESPONSE', true),
    // Cloud ocr_runs write is opt-in: enable only after migrations are applied.
    writeEnabled: readFlag('OCR_PROVENANCE_WRITE', false),
  };
}

function optionalTrimmedString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Cache hit: this request did not run OCR or verifier; origin provenance is unknown. */
export function buildCacheHitProvenance(input: CacheHitProvenanceInput): OcrProvenance {
  const finalFromCache = optionalTrimmedString(input.cachedAnalysis.transactionDate ?? undefined);
  return {
    requestId: input.requestId,
    primaryModel: input.primaryModel,
    cacheVersion: input.cacheVersion,
    cached: true,
    imageContentHash: input.imageContentHash,
    dateVerification: {
      used: false,
      model: null,
      primaryTransactionDate: null,
      verifiedTransactionDate: null,
      finalTransactionDate: finalFromCache,
      verifierSucceeded: null,
    },
  };
}

/** Fresh (cache miss) run: record what THIS request actually did. */
export function buildFreshRunProvenance(input: FreshRunProvenanceInput): OcrProvenance {
  const primary = optionalTrimmedString(input.primaryDate ?? undefined);
  const verified = input.verifierCalled
    ? optionalTrimmedString(input.verifierDate ?? undefined)
    : null;
  const finalDate =
    input.finalTransactionDate === undefined
      ? null
      : input.finalTransactionDate === null
        ? null
        : optionalTrimmedString(input.finalTransactionDate);

  let used: boolean | null = null;
  let verifierSucceeded: boolean | null = null;

  if (input.verificationRequired) {
    used = input.verifierCalled;
    if (input.verifierCalled) {
      verifierSucceeded = input.verifierCallSucceeded
        ? finalDate != null
        : false;
    }
  } else {
    used = false;
    verifierSucceeded = null;
  }

  return {
    requestId: input.requestId,
    primaryModel: input.primaryModel,
    cacheVersion: input.cacheVersion,
    cached: false,
    imageContentHash: input.imageContentHash,
    dateVerification: {
      used,
      model: input.verifierCalled ? input.dateVerifyModel : null,
      primaryTransactionDate: primary,
      verifiedTransactionDate: verified,
      finalTransactionDate: finalDate,
      verifierSucceeded,
    },
  };
}

export function provenanceToOcrRunRow(
  provenance: OcrProvenance,
  userId: string
): OcrRunInsertRow {
  const dv = provenance.dateVerification;
  return {
    request_id: provenance.requestId,
    user_id: userId,
    primary_model: provenance.primaryModel,
    cache_version: provenance.cacheVersion,
    cached: provenance.cached,
    image_content_hash: provenance.imageContentHash ?? null,
    date_verification_used: dv.used ?? null,
    date_verify_model: dv.model ?? null,
    primary_transaction_date: dv.primaryTransactionDate ?? null,
    verified_transaction_date: dv.verifiedTransactionDate ?? null,
    final_transaction_date: dv.finalTransactionDate ?? null,
    verifier_succeeded: dv.verifierSucceeded ?? null,
  };
}

export type PersistOcrRunResult = {
  attempted: boolean;
  persisted: boolean;
  idempotentHit: boolean;
};

/**
 * Insert ocr_runs via service_role. Non-fatal: OCR success must not depend on this.
 * Duplicate request_id (23505) is treated as idempotent success.
 */
export async function persistOcrRun(
  supabase: { from: (table: string) => any },
  row: OcrRunInsertRow,
  writeEnabled: boolean
): Promise<PersistOcrRunResult> {
  if (!writeEnabled) {
    return { attempted: false, persisted: false, idempotentHit: false };
  }

  try {
    const { error } = await supabase.from('ocr_runs').insert(row);
    if (error) {
      if (error.code === '23505') {
        console.warn(
          `[${row.request_id}] ocr_runs insert idempotent duplicate request_id`
        );
        return { attempted: true, persisted: true, idempotentHit: true };
      }
      console.error(
        `[${row.request_id}] ocr_runs insert failed:`,
        error.code || error.message || error
      );
      return { attempted: true, persisted: false, idempotentHit: false };
    }
    return { attempted: true, persisted: true, idempotentHit: false };
  } catch (e) {
    console.error(`[${row.request_id}] ocr_runs insert threw:`, e);
    return { attempted: true, persisted: false, idempotentHit: false };
  }
}

/** Primary usage event request_id must match provenance.requestId (not verifier suffix). */
export function primaryUsageRequestId(provenance: OcrProvenance): string {
  return provenance.requestId;
}

export function verifierUsageRequestId(provenance: OcrProvenance): string {
  return `${provenance.requestId}#date-verify`;
}
