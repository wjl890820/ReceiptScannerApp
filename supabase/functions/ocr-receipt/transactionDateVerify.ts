/**
 * B3 transactionDate verification — pure trigger/acceptance logic (Edge + Jest).
 * Does not call Gemini; OCR handler wires verifier when required.
 */

export type DateVerifyItem = { name?: string | null };

const REASONABLE_WINDOW_MS = {
  futureGraceMs: 24 * 60 * 60 * 1000,
  pastMs: 5 * 365.25 * 24 * 60 * 60 * 1000,
};

function normalizeMerchantName(s: string): string {
  return s
    .trim()
    .replace(/[\s　]/g, '')
    .toLowerCase()
    .replace(/[－—–−ー]/g, '-');
}

/** Conservative Costco recognition — merchant name or structural multi-signal only. */
export function isCostcoForDateVerification(
  merchant?: string | null,
  items?: DateVerifyItem[] | null
): boolean {
  const m = String(merchant || '');
  const mNorm = normalizeMerchantName(m);
  // Direct Costco identity: merchant text only (not arbitrary product names).
  if (/costco|コストコ/.test(mNorm)) {
    return true;
  }

  const itemText = (items || []).map((it) => String(it?.name || '')).join('\n');
  const evidence = `${m}\n${itemText}`;
  let score = 0;
  if (/biz\s*\/?\s*gold|bizgold/i.test(evidence)) score += 1;
  if (/wholesale/i.test(evidence)) score += 1;
  if (
    /御買上げ点数|お買上げ点数|お買上点数|会員番号|membership/i.test(evidence) ||
    /御買上げ点数|お買上げ点数|お買上点数/.test(m)
  ) {
    score += 1;
  }
  const etHits = (items || []).filter((it) =>
    /\s[ET]$|[ET]\s*$/i.test(String(it?.name || '').trim())
  ).length;
  if (etHits >= 2) score += 1;
  const codeHits = (items || []).filter((it) =>
    /^\d{5,6}\b/.test(String(it?.name || '').trim())
  ).length;
  if (codeHits >= 3) score += 1;
  return score >= 2;
}

function isCostcoMerchantHint(merchant?: string | null): boolean {
  if (!merchant || typeof merchant !== 'string') return false;
  const n = normalizeMerchantName(merchant);
  return n.includes('costco') || n.includes('コストコ');
}

function isAmbiguousSlashMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 12;
}

/** Deterministic receipt date normalization (subset of client dateParser). */
export function normalizeReceiptDateTimeForVerify(
  input: string,
  options?: { allowAmbiguousMdy?: boolean }
): string {
  if (!input || typeof input !== 'string') return '';
  let s = input.trim().replace(/\u3000/g, ' ');
  s = s.replace(/[（(][月火水木金土日][)）]/g, ' ').trim();
  s = s.replace(/\s+/g, ' ');

  const jp = s.match(
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (jp) {
    return formatNormalized(jp[1], jp[2], jp[3], jp[4] ?? '0', jp[5] ?? '0', jp[6]);
  }

  const ymd = s.match(
    /^(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );
  if (ymd) {
    return formatNormalized(ymd[1], ymd[2], ymd[3], ymd[4] ?? '0', ymd[5] ?? '0', ymd[6]);
  }

  const mdy = s.match(
    /^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    if (isAmbiguousSlashMonthDay(month, day) && !options?.allowAmbiguousMdy) {
      return '';
    }
    return formatNormalized(mdy[3], mdy[1], mdy[2], mdy[4] ?? '0', mdy[5] ?? '0', mdy[6]);
  }

  return '';
}

function formatNormalized(
  y: string,
  m: string,
  d: string,
  hh: string,
  mm: string,
  ss?: string | null
): string {
  const base = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
  if (ss != null && ss !== '') {
    return `${base}:${String(ss).padStart(2, '0')}`;
  }
  return base;
}

function tokyoTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+09:00`;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  const check = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(check);
  const cy = Number(parts.find((p) => p.type === 'year')?.value);
  const cm = Number(parts.find((p) => p.type === 'month')?.value);
  const cd = Number(parts.find((p) => p.type === 'day')?.value);
  if (cy !== year || cm !== month || cd !== day) return null;
  return ts;
}

export function withinReasonableReceiptDateRange(ts: number, nowMs: number): boolean {
  const oneDayLater = nowMs + REASONABLE_WINDOW_MS.futureGraceMs;
  const fiveYearsAgo = nowMs - REASONABLE_WINDOW_MS.pastMs;
  return ts >= fiveYearsAgo && ts <= oneDayLater;
}

export function hasReliableFourDigitYear(value: string): boolean {
  return /\d{4}/.test(value);
}

export function isTransactionDateSyntacticallyParseable(
  value: string | null | undefined,
  merchant?: string | null
): boolean {
  if (!value || typeof value !== 'string' || !value.trim()) return false;
  const allowAmbiguousMdy = isCostcoMerchantHint(merchant);
  return normalizeReceiptDateTimeForVerify(value.trim(), { allowAmbiguousMdy }) !== '';
}

export function parseReceiptDateTimeForVerify(
  value: string,
  merchant?: string | null,
  nowMs: number = Date.now()
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const allowAmbiguousMdy = isCostcoMerchantHint(merchant);
  const normalized = normalizeReceiptDateTimeForVerify(trimmed, { allowAmbiguousMdy });
  const workStr =
    normalized ||
    trimmed.replace(/[（(][月火水木金土日][)）]/g, ' ').replace(/\s+/g, ' ').trim();

  const withTime = workStr.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/
  );
  if (withTime) {
    const ts = tokyoTimestamp(
      Number(withTime[1]),
      Number(withTime[2]),
      Number(withTime[3]),
      Number(withTime[4]),
      Number(withTime[5]),
      Number(withTime[6] ?? '0')
    );
    if (ts != null && withinReasonableReceiptDateRange(ts, nowMs)) return ts;
  }

  const dateOnly = workStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const ts = tokyoTimestamp(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      0,
      0,
      0
    );
    if (ts != null && withinReasonableReceiptDateRange(ts, nowMs)) return ts;
  }

  return null;
}

function primaryDateTriggersVerification(
  primaryDate: string | null | undefined,
  merchant?: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!primaryDate || typeof primaryDate !== 'string' || !primaryDate.trim()) return true;
  const trimmed = primaryDate.trim();
  if (!hasReliableFourDigitYear(trimmed)) return true;
  if (!isTransactionDateSyntacticallyParseable(trimmed, merchant)) return true;
  if (parseReceiptDateTimeForVerify(trimmed, merchant, nowMs) == null) return true;
  return false;
}

/** True when a date-only Gemini verifier pass is required. */
export function requiresTransactionDateVerification(
  merchant?: string | null,
  primaryDate?: string | null,
  items?: DateVerifyItem[] | null,
  nowMs: number = Date.now()
): boolean {
  if (isCostcoForDateVerification(merchant, items)) return true;
  return primaryDateTriggersVerification(primaryDate, merchant, nowMs);
}

/** Why a verifier candidate was accepted or rejected (diagnostic + cache policy). */
export type VerifierAcceptOutcome =
  | 'accepted'
  | 'empty_or_null'
  | 'missing_four_digit_year'
  | 'unparseable'
  | 'out_of_window'
  | 'api_failure';

export type ClassifyVerifierAcceptResult = {
  accepted: string | null;
  outcome: VerifierAcceptOutcome;
};

/**
 * Classify verifier candidate without changing acceptance semantics.
 * Rejection order matches historical acceptVerifierTransactionDate checks.
 */
export function classifyVerifierAcceptOutcome(
  verifierDate: string | null | undefined,
  merchant?: string | null,
  nowMs: number = Date.now()
): ClassifyVerifierAcceptResult {
  if (!verifierDate || typeof verifierDate !== 'string' || !verifierDate.trim()) {
    return { accepted: null, outcome: 'empty_or_null' };
  }
  const trimmed = verifierDate.trim();
  if (!hasReliableFourDigitYear(trimmed)) {
    return { accepted: null, outcome: 'missing_four_digit_year' };
  }
  if (!isTransactionDateSyntacticallyParseable(trimmed, merchant)) {
    return { accepted: null, outcome: 'unparseable' };
  }
  if (parseReceiptDateTimeForVerify(trimmed, merchant, nowMs) == null) {
    return { accepted: null, outcome: 'out_of_window' };
  }
  return { accepted: trimmed, outcome: 'accepted' };
}

/** Verifier output accepted only when parseable, has year, and in window. */
export function acceptVerifierTransactionDate(
  verifierDate: string | null | undefined,
  merchant?: string | null,
  nowMs: number = Date.now()
): string | null {
  return classifyVerifierAcceptOutcome(verifierDate, merchant, nowMs).accepted;
}

export type ResolveFinalTransactionDateParams = {
  verificationRequired: boolean;
  primaryDate?: string | null;
  verifierDate?: string | null;
  verifierCallSucceeded: boolean;
  merchant?: string | null;
  nowMs?: number;
};

export type ResolveFinalTransactionDateResult = {
  finalTransactionDate: string | null | undefined;
  shouldCache: boolean;
  acceptOutcome: VerifierAcceptOutcome;
};

/**
 * When verification is required, verifier is authoritative if valid; else null.
 * Never fall back to suspicious primary.
 * Transient verifier API failure => no cache.
 * Verifier API success but no accepted date => no cache (avoid durable negative cache).
 */
export function resolveFinalTransactionDate(
  params: ResolveFinalTransactionDateParams
): ResolveFinalTransactionDateResult {
  const nowMs = params.nowMs ?? Date.now();

  if (!params.verificationRequired) {
    const primary =
      typeof params.primaryDate === 'string' && params.primaryDate.trim()
        ? params.primaryDate.trim()
        : undefined;
    return {
      finalTransactionDate: primary,
      shouldCache: true,
      acceptOutcome: primary ? 'accepted' : 'empty_or_null',
    };
  }

  if (!params.verifierCallSucceeded) {
    return {
      finalTransactionDate: null,
      shouldCache: false,
      acceptOutcome: 'api_failure',
    };
  }

  const classified = classifyVerifierAcceptOutcome(
    params.verifierDate,
    params.merchant,
    nowMs
  );
  return {
    finalTransactionDate: classified.accepted,
    // Do not durable-cache uncertain/rejected verifier success (negative cache).
    shouldCache: classified.accepted != null,
    acceptOutcome: classified.outcome,
  };
}

/** True when cached analysis.transactionDate cannot be used as a verified date. */
export function isUnusableCachedTransactionDate(value: unknown): boolean {
  return typeof value !== 'string' || !String(value).trim();
}

/**
 * Required-verification rows that stored a null/empty date must not short-circuit
 * future OCR+verifier attempts (negative cache bypass).
 */
export function shouldBypassNegativeDateVerificationCache(
  analysis:
    | {
        merchant?: string | null;
        transactionDate?: string | null;
        items?: DateVerifyItem[] | null;
      }
    | null
    | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!analysis || typeof analysis !== 'object') return false;
  if (!isUnusableCachedTransactionDate(analysis.transactionDate)) return false;
  return requiresTransactionDateVerification(
    analysis.merchant,
    analysis.transactionDate ?? null,
    analysis.items,
    nowMs
  );
}

export type DateVerifyCallResult = {
  transactionDate: string | null;
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
};

/** Orchestration helper for deterministic tests (mock verifyFn). */
export async function applyTransactionDateVerification(params: {
  merchant?: string | null;
  primaryDate?: string | null;
  items?: DateVerifyItem[] | null;
  nowMs?: number;
  verifyFn?: () => Promise<DateVerifyCallResult>;
}): Promise<{
  finalTransactionDate: string | null | undefined;
  shouldCache: boolean;
  verificationRequired: boolean;
  verifierCalled: boolean;
}> {
  const nowMs = params.nowMs ?? Date.now();
  const verificationRequired = requiresTransactionDateVerification(
    params.merchant,
    params.primaryDate,
    params.items,
    nowMs
  );

  if (!verificationRequired) {
    const primary =
      typeof params.primaryDate === 'string' && params.primaryDate.trim()
        ? params.primaryDate.trim()
        : undefined;
    return {
      finalTransactionDate: primary,
      shouldCache: true,
      verificationRequired: false,
      verifierCalled: false,
    };
  }

  if (!params.verifyFn) {
    throw new Error('verifyFn required when verificationRequired');
  }

  let verifierCallSucceeded = false;
  let verifierDate: string | null | undefined;

  try {
    const result = await params.verifyFn();
    verifierCallSucceeded = true;
    verifierDate = result.transactionDate;
  } catch {
    verifierCallSucceeded = false;
  }

  const resolved = resolveFinalTransactionDate({
    verificationRequired: true,
    primaryDate: params.primaryDate,
    verifierDate,
    verifierCallSucceeded,
    merchant: params.merchant,
    nowMs,
  });

  return {
    finalTransactionDate: resolved.finalTransactionDate,
    shouldCache: resolved.shouldCache,
    verificationRequired: true,
    verifierCalled: true,
  };
}
