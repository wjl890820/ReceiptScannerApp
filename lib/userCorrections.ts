/**
 * MERUNO user correction provenance contract (M1-C).
 *
 * Separates:
 * - effective user override (current value used by UI/analytics)
 * - correction provenance (before → after evidence for supervision)
 *
 * RAW OCR / recognition snapshots must never be mutated to record corrections.
 * Prefer append-only arrays inside durable user/receipt JSON.
 */

import {
  CLASSIFICATION_VERSION,
  TAXONOMY_VERSION,
  isExplicitUserCategoryOverride,
} from './productTaxonomy';

export const USER_CORRECTIONS_CONTRACT_VERSION = 'meruno-user-corrections-v1' as const;

/** Fields currently editable or forward-compatible for V1. */
export type UserCorrectionField =
  | 'item_name'
  | 'item_amount'
  | 'item_quantity'
  | 'item_category'
  | 'item_spec'
  | 'merchant'
  | 'transaction_date'
  | 'receipt_total'
  | 'receipt_tax'
  | 'receipt_note';

export type UserCorrectionSource = 'user';

/** Where the overridden value originally came from. */
export type UserCorrectionOriginalSource =
  | 'ocr'
  | 'machine'
  | 'user'
  | 'unknown'
  | 'legacy_unavailable';

export type UserCorrectionValue = string | number | boolean | null;

/**
 * One explicit user correction event.
 * Append-only: repeated edits create additional entries (69→70, then 70→72).
 */
export type UserCorrectionEvent = {
  field: UserCorrectionField;
  originalValue: UserCorrectionValue;
  correctedValue: UserCorrectionValue;
  /** UTC ISO-8601 timestamp of this explicit correction. */
  correctedAt: string;
  source: UserCorrectionSource;
  /** Provenance of the value being replaced. */
  originalSource?: UserCorrectionOriginalSource;
  /** Prior classification_source when field=item_category. */
  previousClassificationSource?: string | null;
  /** Prior classification_version when field=item_category. */
  previousClassificationVersion?: string | null;
  taxonomyVersion?: string | null;
  /** Index into OCR/analysis items when known. */
  itemSourceIndex?: number | null;
  contractVersion?: typeof USER_CORRECTIONS_CONTRACT_VERSION;
};

export type UserCorrectionHost = {
  user_corrections?: unknown;
  [key: string]: unknown;
};

export type RecordUserCorrectionInput = {
  field: UserCorrectionField;
  originalValue: UserCorrectionValue;
  correctedValue: UserCorrectionValue;
  originalSource?: UserCorrectionOriginalSource;
  previousClassificationSource?: string | null;
  previousClassificationVersion?: string | null;
  taxonomyVersion?: string | null;
  itemSourceIndex?: number | null;
  /** Injectable clock for tests. */
  now?: () => Date;
};

function valuesEqual(a: UserCorrectionValue, b: UserCorrectionValue): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return String(a ?? '') === String(b ?? '');
}

export function toCorrectionIsoTimestamp(date = new Date()): string {
  return date.toISOString();
}

export function isUserCorrectionEvent(value: unknown): value is UserCorrectionEvent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.field === 'string' &&
    typeof row.correctedAt === 'string' &&
    row.source === 'user' &&
    'originalValue' in row &&
    'correctedValue' in row
  );
}

export function readUserCorrections(host: UserCorrectionHost | null | undefined): UserCorrectionEvent[] {
  const raw = host?.user_corrections;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isUserCorrectionEvent);
}

/**
 * Build one correction event. Returns null when values are unchanged
 * (no-op edits must not invent provenance).
 */
export function buildUserCorrectionEvent(
  input: RecordUserCorrectionInput
): UserCorrectionEvent | null {
  if (valuesEqual(input.originalValue, input.correctedValue)) return null;
  const now = input.now ? input.now() : new Date();
  return {
    field: input.field,
    originalValue: input.originalValue,
    correctedValue: input.correctedValue,
    correctedAt: toCorrectionIsoTimestamp(now),
    source: 'user',
    originalSource: input.originalSource ?? 'unknown',
    previousClassificationSource: input.previousClassificationSource ?? null,
    previousClassificationVersion: input.previousClassificationVersion ?? null,
    taxonomyVersion: input.taxonomyVersion ?? TAXONOMY_VERSION,
    itemSourceIndex:
      typeof input.itemSourceIndex === 'number' && Number.isInteger(input.itemSourceIndex)
        ? input.itemSourceIndex
        : null,
    contractVersion: USER_CORRECTIONS_CONTRACT_VERSION,
  };
}

/**
 * Append correction event(s) onto a host object (item or receipt analysis root).
 * Does not mutate the input host.
 */
export function appendUserCorrections<T extends UserCorrectionHost>(
  host: T,
  events: Array<UserCorrectionEvent | null | undefined>
): T {
  const nextEvents = events.filter((e): e is UserCorrectionEvent => e != null);
  if (nextEvents.length === 0) return host;
  const existing = readUserCorrections(host);
  return {
    ...host,
    user_corrections: [...existing, ...nextEvents],
  };
}

export function recordUserCorrection<T extends UserCorrectionHost>(
  host: T,
  input: RecordUserCorrectionInput
): T {
  return appendUserCorrections(host, [buildUserCorrectionEvent(input)]);
}

export function latestUserCorrection(
  host: UserCorrectionHost | null | undefined,
  field: UserCorrectionField
): UserCorrectionEvent | null {
  const rows = readUserCorrections(host).filter((row) => row.field === field);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/**
 * Historical edits may have amountUserEdited / classification_source=user
 * without a corrections array. Do not invent before/after values.
 */
export function resolveLegacyUserOverrideProvenance(input: {
  hasExplicitOverride: boolean;
  hasCorrectionEvents: boolean;
}): {
  status: 'available' | 'legacy_unavailable' | 'none';
} {
  if (input.hasCorrectionEvents) return { status: 'available' };
  if (input.hasExplicitOverride) return { status: 'legacy_unavailable' };
  return { status: 'none' };
}

export function categoryCorrectionInput(args: {
  beforeCategory: string;
  afterCategory: string;
  beforeItem?: {
    classification_source?: unknown;
    classification_version?: unknown;
    taxonomy_version?: unknown;
  } | null;
  itemSourceIndex?: number | null;
  now?: () => Date;
}): RecordUserCorrectionInput {
  const before = args.beforeItem;
  const hadUser = isExplicitUserCategoryOverride(before ?? null);
  return {
    field: 'item_category',
    originalValue: args.beforeCategory,
    correctedValue: args.afterCategory,
    originalSource: hadUser ? 'user' : 'machine',
    previousClassificationSource:
      typeof before?.classification_source === 'string'
        ? before.classification_source
        : hadUser
          ? 'user'
          : 'unknown',
    previousClassificationVersion:
      typeof before?.classification_version === 'string'
        ? before.classification_version
        : hadUser
          ? null
          : CLASSIFICATION_VERSION,
    taxonomyVersion:
      typeof before?.taxonomy_version === 'string'
        ? before.taxonomy_version
        : TAXONOMY_VERSION,
    itemSourceIndex: args.itemSourceIndex,
    now: args.now,
  };
}

export function amountCorrectionInput(args: {
  beforeAmount: number;
  afterAmount: number;
  previouslyUserEdited?: boolean;
  itemSourceIndex?: number | null;
  now?: () => Date;
}): RecordUserCorrectionInput {
  return {
    field: 'item_amount',
    originalValue: args.beforeAmount,
    correctedValue: args.afterAmount,
    originalSource: args.previouslyUserEdited ? 'user' : 'ocr',
    itemSourceIndex: args.itemSourceIndex,
    now: args.now,
  };
}

export function quantityCorrectionInput(args: {
  beforeQuantity: number;
  afterQuantity: number;
  previouslyUserEdited?: boolean;
  itemSourceIndex?: number | null;
  now?: () => Date;
}): RecordUserCorrectionInput {
  return {
    field: 'item_quantity',
    originalValue: args.beforeQuantity,
    correctedValue: args.afterQuantity,
    originalSource: args.previouslyUserEdited ? 'user' : 'ocr',
    itemSourceIndex: args.itemSourceIndex,
    now: args.now,
  };
}

export function nameCorrectionInput(args: {
  beforeName: string;
  afterName: string;
  previouslyUserEdited?: boolean;
  itemSourceIndex?: number | null;
  now?: () => Date;
}): RecordUserCorrectionInput {
  return {
    field: 'item_name',
    originalValue: args.beforeName,
    correctedValue: args.afterName,
    originalSource: args.previouslyUserEdited ? 'user' : 'ocr',
    itemSourceIndex: args.itemSourceIndex,
    now: args.now,
  };
}

export function receiptFieldCorrectionInput(args: {
  field: Extract<
    UserCorrectionField,
    'merchant' | 'transaction_date' | 'receipt_total' | 'receipt_tax' | 'receipt_note'
  >;
  originalValue: UserCorrectionValue;
  correctedValue: UserCorrectionValue;
  originalSource?: UserCorrectionOriginalSource;
  now?: () => Date;
}): RecordUserCorrectionInput {
  return {
    field: args.field,
    originalValue: args.originalValue,
    correctedValue: args.correctedValue,
    originalSource: args.originalSource ?? 'ocr',
    now: args.now,
  };
}

/**
 * Apply item-level corrections for history/review edits in one place.
 * Leaves host untouched when nothing changed.
 */
export function applyItemFieldCorrections<T extends UserCorrectionHost>(
  host: T,
  inputs: RecordUserCorrectionInput[]
): T {
  return appendUserCorrections(
    host,
    inputs.map((input) => buildUserCorrectionEvent(input))
  );
}

/** Privacy boundary: corrections stay in private receipt JSON; never for analytics payloads. */
export function stripUserCorrectionsForAnalyticsExport<T extends UserCorrectionHost>(
  host: T
): Omit<T, 'user_corrections'> {
  const { user_corrections: _removed, ...rest } = host;
  return rest;
}
