/**
 * Receipt purchase datetime parsing for Japanese retail receipts.
 * Always uses Asia/Tokyo wall-clock semantics. Never falls back to "now"
 * unless callers explicitly pass fallbackToNow=true (save path must pass false).
 */

export type ParseReceiptDateTimeOptions = {
  fallbackToNow?: boolean;
  /** Injected clock for tests — defaults to Date.now(). */
  nowMs?: number;
};

/**
 * Strip weekday markers / full-width spaces and normalize JP / slash / dash forms
 * into "YYYY-MM-DD HH:mm" when possible. Returns '' only when unusable.
 *
 * OCR may insert spaces around separators (e.g. "2026/ 2/21") and optional
 * JP weekday annotations between date and time ((土) / （土）). Those are
 * normalized deterministically — no fuzzy guessing.
 */
export function normalizeReceiptDateTime(input: string): string {
  if (!input || typeof input !== 'string') return '';
  let s = input.trim().replace(/\u3000/g, ' ');
  // Remove recognized JP weekday markers only; leave a space so date|time stay split.
  s = s.replace(/[（(][月火水木金土日][)）]/g, ' ').trim();
  s = s.replace(/\s+/g, ' ');

  // YYYY年M月D日[ HH:mm[:ss]]
  const jp = s.match(
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (jp) {
    return formatNormalized(
      jp[1],
      jp[2],
      jp[3],
      jp[4] ?? '0',
      jp[5] ?? '0',
      jp[6]
    );
  }

  // YYYY/MM/DD or YYYY-MM-DD [HH:mm[:ss]] — allow OCR whitespace around separators
  const ymd = s.match(
    /^(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );
  if (ymd) {
    return formatNormalized(
      ymd[1],
      ymd[2],
      ymd[3],
      ymd[4] ?? '0',
      ymd[5] ?? '0',
      ymd[6]
    );
  }

  // MM/DD/YYYY [HH:mm[:ss]] (Costco US-style) — allow OCR whitespace around /
  const mdy = s.match(
    /^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );
  if (mdy) {
    return formatNormalized(
      mdy[3],
      mdy[1],
      mdy[2],
      mdy[4] ?? '0',
      mdy[5] ?? '0',
      mdy[6]
    );
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
  // Validate calendar day via Tokyo components
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

function withinReasonableRange(ts: number, nowMs: number): boolean {
  const oneDayLater = nowMs + 24 * 60 * 60 * 1000;
  const fiveYearsAgo = nowMs - 5 * 365.25 * 24 * 60 * 60 * 1000;
  return ts >= fiveYearsAgo && ts <= oneDayLater;
}

/**
 * Strict machine-safe ISO-8601 with explicit timezone (Z or ±HH:MM).
 * Date-only / timezone-less strings are intentionally rejected here.
 */
function parseStrictMachineIso(value: string): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  ) {
    return null;
  }
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Parse receipt purchase datetime → epoch ms (Asia/Tokyo wall clock).
 *
 * Precedence:
 * 1) Deterministic human receipt formats (JP / slash / Costco MM/DD/YYYY)
 * 2) Strict ISO-8601 with explicit timezone only
 * Never: new Date(rawReceiptString) for human/slash/date-only values.
 */
export function parseReceiptDateTime(
  dateTimeStr: string | null | undefined,
  fallbackToNow: boolean | ParseReceiptDateTimeOptions = false,
  nowMsArg?: number
): number | null {
  const options: ParseReceiptDateTimeOptions =
    typeof fallbackToNow === 'object' && fallbackToNow
      ? fallbackToNow
      : { fallbackToNow: Boolean(fallbackToNow), nowMs: nowMsArg };

  const fallback = Boolean(options.fallbackToNow);
  const nowMs = options.nowMs ?? Date.now();

  if (!dateTimeStr || typeof dateTimeStr !== 'string') {
    return fallback ? nowMs : null;
  }
  const trimmed = dateTimeStr.trim();
  if (!trimmed) {
    return fallback ? nowMs : null;
  }

  // 1) Deterministic receipt formats → Tokyo wall-clock components → +09:00 ISO.
  const normalized = normalizeReceiptDateTime(trimmed);
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
    if (ts != null && withinReasonableRange(ts, nowMs)) return ts;
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
    if (ts != null && withinReasonableRange(ts, nowMs)) return ts;
  }

  // MM/DD without year — assume current Tokyo calendar year
  const md = workStr.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (md) {
    const tokyoYear = Number(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
      }).format(new Date(nowMs))
    );
    const ts = tokyoTimestamp(
      tokyoYear,
      Number(md[1]),
      Number(md[2]),
      Number(md[3]),
      Number(md[4]),
      Number(md[5] ?? '0')
    );
    if (ts != null && withinReasonableRange(ts, nowMs)) return ts;
  }

  // 2) Only after deterministic formats fail: verified machine ISO with timezone.
  const machineIso = parseStrictMachineIso(trimmed);
  if (machineIso != null && withinReasonableRange(machineIso, nowMs)) {
    return machineIso;
  }

  return fallback ? nowMs : null;
}
