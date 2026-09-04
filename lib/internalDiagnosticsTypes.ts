/**
 * Internal Diagnostics V1 — event schema, privacy limits, ring buffer.
 * Schema 2: UTF-8 byte budget + trusted input-boundary normalization.
 */

export const INTERNAL_DIAGNOSTICS_SCHEMA_VERSION = 2;
/** Previous persisted schema (discarded; no migration). */
export const INTERNAL_DIAGNOSTICS_LEGACY_SCHEMA_VERSION = 1;

export const INTERNAL_DIAGNOSTICS_RING_CAPACITY = 800;

/** Per-event maximum serialized UTF-8 bytes. */
export const INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES = 6144;

export const INTERNAL_DIAGNOSTICS_MAX_META_KEYS = 24;
export const INTERNAL_DIAGNOSTICS_MAX_STRING_CHARS = 256;
export const INTERNAL_DIAGNOSTICS_MAX_ARRAY_LEN = 16;
export const INTERNAL_DIAGNOSTICS_MAX_NAME_CHARS = 120;
export const INTERNAL_DIAGNOSTICS_MAX_SCREEN_CHARS = 80;

export type DiagnosticJsonPrimitive = string | number | boolean | null;
/** Flat meta only — no nested objects. */
export type DiagnosticMetaValue =
  | DiagnosticJsonPrimitive
  | DiagnosticJsonPrimitive[];

export type DiagnosticEventCategory =
  | 'lifecycle'
  | 'timing'
  | 'coordinator'
  | 'warning'
  | 'error'
  | 'session'
  | 'export';

export type DiagnosticEvent = {
  ts: number;
  tRel: number;
  category: DiagnosticEventCategory;
  name: string;
  screen: string;
  sessionId: string;
  durationMs?: number;
  meta?: Record<string, DiagnosticMetaValue>;
};

export type NormalizedDiagnosticError = {
  name: string;
  code?: string | number;
};

const CATEGORIES = new Set<string>([
  'lifecycle',
  'timing',
  'coordinator',
  'warning',
  'error',
  'session',
  'export',
]);

/**
 * Canonicalize optional meta keys for denylist matching:
 * lowercase + strip non-alphanumeric.
 * product_name / product-name / ProductName → productname
 */
export function canonicalizeDiagnosticMetaKey(key: string): string {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Exact-match denylist on canonicalized keys (optional meta only). */
const BLOCKED_CANONICAL_META_KEYS = new Set([
  'data',
  'meta',
  'response',
  'request',
  'config',
  'headers',
  'body',
  'receipt',
  'ocr',
  'ocrtext',
  'product',
  'productname',
  'merchant',
  'account',
  'accountid',
  'email',
  'emailaddress',
  'token',
  'password',
  'authorization',
  'auth',
  'credential',
  'secret',
  'apikey',
  'url',
  'uri',
  'image',
  'stack',
  'cause',
  'analysis',
]);

/**
 * Extra substring family blocks on canonical keys (after allowlist).
 * Kept narrow to avoid blocking receiptCount / analyticsReceiptCount.
 */
const BLOCKED_CANONICAL_SUBSTRINGS = [
  'token',
  'password',
  'secret',
  'credential',
  'authorization',
  'apikey',
  'ocrtext',
  'emailaddress',
  'productname',
  'accountid',
] as const;

/** Safe diagnostic keys that must survive even if they contain blocked roots. */
const ALLOWED_CANONICAL_META_KEYS = new Set([
  'cycleid',
  'receiptcount',
  'analyticsreceiptcount',
  'duration',
  'durationms',
  'trigger',
  'epoch',
  'status',
  'sessionid',
  'screen',
  'level',
  'errorname',
  'errorcode',
  'runid',
  'visibilityepoch',
  'activerunid',
  'applied',
  'phase',
  'kind',
  'success',
  'mode',
  'focusid',
  'via',
  'productrowcount',
  'incompletecount',
  'blockedbyrunid',
  'blockedbyepoch',
  'intoscheduledvisibilityid',
  'eventcount',
]);

export function isBlockedDiagnosticMetaKey(key: string): boolean {
  const canonical = canonicalizeDiagnosticMetaKey(key);
  if (!canonical) return true;
  if (ALLOWED_CANONICAL_META_KEYS.has(canonical)) return false;
  if (BLOCKED_CANONICAL_META_KEYS.has(canonical)) return true;
  for (const part of BLOCKED_CANONICAL_SUBSTRINGS) {
    if (canonical.includes(part)) return true;
  }
  return false;
}

export function boundDiagnosticString(
  value: unknown,
  maxChars: number = INTERNAL_DIAGNOSTICS_MAX_STRING_CHARS
): string {
  const raw =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : String(value);
  return raw.slice(0, maxChars);
}

/** Genuine Error detection — no structural duck typing. */
export function isGenuineDiagnosticError(value: unknown): value is Error {
  return typeof Error !== 'undefined' && value instanceof Error;
}

/**
 * Safe error fields only from a genuine Error: name + optional primitive code.
 * Never persists message/stack/request/response/cause.
 */
export function normalizeDiagnosticError(
  error: unknown
): NormalizedDiagnosticError | null {
  if (!isGenuineDiagnosticError(error)) return null;
  const name = boundDiagnosticString(error.name || 'Error', 120);
  const rawCode = (error as { code?: unknown }).code;
  if (typeof rawCode === 'string') {
    return { name, code: boundDiagnosticString(rawCode, 64) };
  }
  if (typeof rawCode === 'number' && Number.isFinite(rawCode)) {
    return { name, code: rawCode };
  }
  return { name };
}

function sanitizePrimitive(
  value: unknown
): DiagnosticJsonPrimitive | undefined {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    return boundDiagnosticString(value);
  }
  return undefined;
}

/**
 * Strict V1 metadata: primitives or small primitive arrays only.
 * Nested objects are dropped entirely. Keys are denylisted after canonicalization.
 */
export function sanitizeDiagnosticMeta(
  meta: Record<string, unknown> | undefined
): Record<string, DiagnosticMetaValue> | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const out: Record<string, DiagnosticMetaValue> = {};
  let keys = 0;
  try {
    for (const [rawKey, value] of Object.entries(meta)) {
      if (keys >= INTERNAL_DIAGNOSTICS_MAX_META_KEYS) break;
      const key = boundDiagnosticString(rawKey, 64);
      if (!key || isBlockedDiagnosticMetaKey(key)) continue;

      if (Array.isArray(value)) {
        const arr: DiagnosticJsonPrimitive[] = [];
        for (const item of value.slice(0, INTERNAL_DIAGNOSTICS_MAX_ARRAY_LEN)) {
          const p = sanitizePrimitive(item);
          if (p !== undefined) arr.push(p);
        }
        if (arr.length > 0) {
          out[key] = arr;
          keys += 1;
        }
        continue;
      }

      if (value !== null && typeof value === 'object') continue;

      const p = sanitizePrimitive(value);
      if (p !== undefined) {
        out[key] = p;
        keys += 1;
      }
    }
  } catch {
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * UTF-8 byte length of a JS string (Hermes/RN compatible).
 * Prefer TextEncoder when available; otherwise manual UTF-8 sizing.
 */
export function utf8ByteLength(value: string): number {
  try {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(value).byteLength;
    }
  } catch {
    // fall through
  }
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair → 4 UTF-8 bytes
      i += 1;
      bytes += 4;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Serialized UTF-8 byte size of a diagnostic event JSON. */
export function estimateDiagnosticEventBytes(event: DiagnosticEvent): number {
  try {
    return utf8ByteLength(JSON.stringify(event));
  } catch {
    return INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES + 1;
  }
}

/**
 * Enforce per-event UTF-8 byte budget. Drops meta first, then truncates strings.
 * Never throws. Never returns an event above the budget.
 */
export function clampDiagnosticEventToBudget(
  event: DiagnosticEvent
): DiagnosticEvent {
  try {
    if (estimateDiagnosticEventBytes(event) <= INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES) {
      return event;
    }
    const withoutMeta: DiagnosticEvent = { ...event };
    delete withoutMeta.meta;
    if (
      estimateDiagnosticEventBytes(withoutMeta) <=
      INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
    ) {
      return withoutMeta;
    }
    let candidate: DiagnosticEvent = {
      ...withoutMeta,
      name: boundDiagnosticString(withoutMeta.name, 64),
      screen: boundDiagnosticString(withoutMeta.screen, 40),
      sessionId: boundDiagnosticString(withoutMeta.sessionId, 40),
    };
    if (estimateDiagnosticEventBytes(candidate) <= INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES) {
      return candidate;
    }
    candidate = {
      ts: event.ts,
      tRel: event.tRel,
      category: event.category,
      name: 'oversized_event',
      screen: boundDiagnosticString(event.screen, 16),
      sessionId: boundDiagnosticString(event.sessionId, 24),
    };
    if (estimateDiagnosticEventBytes(candidate) <= INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES) {
      return candidate;
    }
    // Absolute fallback — still must fit.
    return {
      ts: Number.isFinite(event.ts) ? event.ts : 0,
      tRel: Number.isFinite(event.tRel) ? event.tRel : 0,
      category: 'session',
      name: 'oversized',
      screen: 'diag',
      sessionId: 'x',
    };
  } catch {
    return {
      ts: 0,
      tRel: 0,
      category: 'session',
      name: 'oversized',
      screen: 'diag',
      sessionId: 'x',
    };
  }
}

/**
 * Authoritative event normalization boundary.
 * Every live ring-buffer entry must pass through this (including hydration).
 */
export function normalizeDiagnosticEvent(input: {
  ts: number;
  tRel: number;
  category: DiagnosticEventCategory;
  name: string;
  screen: string;
  sessionId: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}): DiagnosticEvent {
  const meta = sanitizeDiagnosticMeta(input.meta);
  const event: DiagnosticEvent = {
    ts: input.ts,
    tRel: input.tRel,
    category: input.category,
    name: boundDiagnosticString(input.name, INTERNAL_DIAGNOSTICS_MAX_NAME_CHARS),
    screen: boundDiagnosticString(
      input.screen,
      INTERNAL_DIAGNOSTICS_MAX_SCREEN_CHARS
    ),
    sessionId: boundDiagnosticString(input.sessionId, 80),
    ...(input.durationMs != null && Number.isFinite(input.durationMs)
      ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
      : {}),
    ...(meta ? { meta } : {}),
  };
  return clampDiagnosticEventToBudget(event);
}

/** @deprecated Prefer normalizeDiagnosticEvent — kept as alias. */
export const buildDiagnosticEvent = normalizeDiagnosticEvent;

/**
 * Re-validate untrusted persisted / restored event objects.
 * Returns null if malformed / unsafely oversized after clamp failure.
 */
export function normalizeDiagnosticEventFromUnknown(
  raw: unknown
): DiagnosticEvent | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const e = raw as Record<string, unknown>;
    if (
      typeof e.ts !== 'number' ||
      !Number.isFinite(e.ts) ||
      typeof e.tRel !== 'number' ||
      !Number.isFinite(e.tRel) ||
      typeof e.category !== 'string' ||
      !CATEGORIES.has(e.category) ||
      typeof e.name !== 'string' ||
      typeof e.screen !== 'string' ||
      typeof e.sessionId !== 'string'
    ) {
      return null;
    }
    const durationMs =
      typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)
        ? e.durationMs
        : undefined;
    const meta =
      e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta)
        ? (e.meta as Record<string, unknown>)
        : undefined;
    const normalized = normalizeDiagnosticEvent({
      ts: e.ts,
      tRel: e.tRel,
      category: e.category as DiagnosticEventCategory,
      name: e.name,
      screen: e.screen,
      sessionId: e.sessionId,
      durationMs,
      meta,
    });
    if (estimateDiagnosticEventBytes(normalized) > INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

export class DiagnosticRingBuffer {
  private readonly capacity: number;
  private readonly slots: Array<DiagnosticEvent | undefined>;
  private start = 0;
  private size = 0;

  constructor(capacity: number = INTERNAL_DIAGNOSTICS_RING_CAPACITY) {
    this.capacity = Math.max(1, capacity);
    this.slots = new Array(this.capacity);
  }

  get length(): number {
    return this.size;
  }

  getCapacity(): number {
    return this.capacity;
  }

  /** Push an already-normalized event. */
  push(event: DiagnosticEvent): void {
    if (this.size < this.capacity) {
      this.slots[(this.start + this.size) % this.capacity] = event;
      this.size += 1;
      return;
    }
    this.slots[this.start] = event;
    this.start = (this.start + 1) % this.capacity;
  }

  clear(): void {
    this.start = 0;
    this.size = 0;
    for (let i = 0; i < this.capacity; i += 1) {
      this.slots[i] = undefined;
    }
  }

  getAll(): DiagnosticEvent[] {
    const out: DiagnosticEvent[] = [];
    for (let i = 0; i < this.size; i += 1) {
      const event = this.slots[(this.start + i) % this.capacity];
      if (event) out.push(event);
    }
    return out;
  }

  /**
   * Replace from untrusted events: each entry is re-normalized.
   * Malformed entries are skipped and do not consume capacity.
   * Keeps the latest `capacity` accepted events.
   */
  replaceAllFromUnknown(events: readonly unknown[]): void {
    this.clear();
    const accepted: DiagnosticEvent[] = [];
    for (const item of events) {
      const normalized = normalizeDiagnosticEventFromUnknown(item);
      if (normalized) accepted.push(normalized);
    }
    const start = Math.max(0, accepted.length - this.capacity);
    for (let i = start; i < accepted.length; i += 1) {
      this.push(accepted[i]!);
    }
  }

  /** @deprecated Prefer replaceAllFromUnknown for untrusted input. */
  replaceAll(events: readonly DiagnosticEvent[]): void {
    this.replaceAllFromUnknown(events);
  }
}
