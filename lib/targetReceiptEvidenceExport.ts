/**
 * Temporary INTERNAL / Validation instrumentation.
 * Read-only SELECT evidence for fixed target receipts only.
 * Does not alter monetary recovery, indexes, or domain semantics.
 */

import {
  getInitializedReceiptsDatabaseOrThrow,
  ReceiptsDatabaseNotInitializedError,
} from './db';

export const TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION = 5 as const;

/**
 * Authoritative static-target registry — MODULE-PRIVATE.
 * Must never be exported (runtime-mutable if exposed).
 */
const TARGET_RECEIPT_EVIDENCE_SPECS = {
  auq_poultry: {
    key: 'auq_poultry',
    receiptId: 'auq8r7qU-EN_l38Y2xDea',
    sourceIndices: [0, 1] as const,
    filenameSlug: 'auq',
    primarySourceIndex: 0,
    diagnosticMerchantProductId: null as string | null,
  },
  receipt063_seiyu_inline_markdown: {
    key: 'receipt063_seiyu_inline_markdown',
    receiptId: 'xQCDD8d8OAAewZdYpTs4p',
    sourceIndices: [8, 9] as const,
    filenameSlug: 'receipt063',
    primarySourceIndex: 8,
    diagnosticMerchantProductId: null as string | null,
  },
  receipt061_aeon_quantity: {
    key: 'receipt061_aeon_quantity',
    receiptId: 'Lgo6ObHsTqXTc8h1WOz7-',
    sourceIndices: [1, 2, 3] as const,
    filenameSlug: 'receipt061',
    primarySourceIndex: 2,
    diagnosticMerchantProductId: 'mp_d3153e4f0c0bc8bb' as string | null,
  },
} as const;

export type TargetReceiptEvidenceTargetKey =
  keyof typeof TARGET_RECEIPT_EVIDENCE_SPECS;

/** Module-private resolved target — never accepted from public callers. */
type TargetReceiptEvidenceSpec = {
  key: TargetReceiptEvidenceTargetKey;
  receiptId: string;
  sourceIndices: readonly number[];
  filenameSlug: string;
  primarySourceIndex: number;
  diagnosticMerchantProductId: string | null;
};

/** Safe public key list (strings only — not the authoritative registry). */
export const TARGET_RECEIPT_EVIDENCE_TARGET_KEYS = Object.freeze(
  Object.keys(TARGET_RECEIPT_EVIDENCE_SPECS) as TargetReceiptEvidenceTargetKey[]
);

export class UnknownTargetReceiptEvidenceTargetKeyError extends Error {
  readonly targetKey: string;
  constructor(targetKey: string) {
    super(`target_receipt_evidence_unknown_target_key:${targetKey}`);
    this.name = 'UnknownTargetReceiptEvidenceTargetKeyError';
    this.targetKey = targetKey;
  }
}

/** Auq receipt id constant (immutable string; not a live registry reference). */
export const TARGET_RECEIPT_EVIDENCE_RECEIPT_ID =
  TARGET_RECEIPT_EVIDENCE_SPECS.auq_poultry.receiptId;

export const TARGET_RECEIPT_EVIDENCE_PRIVACY_WARNING =
  'This JSON contains narrow monetary evidence for one local receipt. Share only with trusted recipients.';

/** Forbidden broad keys that must never appear as dumped object keys in export JSON. */
export const TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS = [
  'image_uri',
  'recognition_snapshot_json',
  'receipts":[',
  'access_token',
  'refresh_token',
  'Authorization',
  '"fullText":',
] as const;

/** Object keys that must never appear in the export tree (OCR blob dumps). */
const FORBIDDEN_EXPORT_OBJECT_KEYS = new Set([
  'image_uri',
  'recognition_snapshot_json',
  'access_token',
  'refresh_token',
  'Authorization',
  'ocr_raw_text',
  'rawText',
  'raw_text',
  'fullText',
  'ocrText',
  'recognizedText',
  'text',
]);

/** Metadata keys allowed to name supported OCR source fields as string values. */
const ALLOWED_SOURCE_FIELD_METADATA_KEYS = new Set([
  'sourceField',
  'alsoPresentSupportedSourceFields',
]);

/** Top-level recognition keys that may hold unbounded OCR/text — never exported. */
const RECOGNITION_RAW_TEXT_TOP_LEVEL_KEYS = [
  'ocr_raw_text',
  'rawText',
  'raw_text',
  'ocrText',
  'fullText',
  'text',
  'lines',
  'blocks',
  'words',
  'tokens',
] as const;

const RECOGNITION_IMAGE_TOP_LEVEL_KEYS = [
  'image',
  'imageUri',
  'image_uri',
  'imageBase64',
  'image_bytes',
] as const;

export const TARGET_RECEIPT_RECOGNITION_OMITTED_TOP_LEVEL_KEYS = [
  ...RECOGNITION_RAW_TEXT_TOP_LEVEL_KEYS,
  ...RECOGNITION_IMAGE_TOP_LEVEL_KEYS,
] as const;

const RECONCILIATION_ALLOWLIST = [
  'ok',
  'itemsPositiveSum',
  'discountsSum',
  'tax',
  'total',
  'expectedTotal',
  'diff',
] as const;

/**
 * Canonical + legacy OCR text fields only (ReceiptAnalysis producers).
 * Precedence: ocr_raw_text then rawText. No guessed aliases.
 */
const RECOGNITION_TEXT_PROBE_SUPPORTED_KEYS = ['ocr_raw_text', 'rawText'] as const;

export type RecognitionTextSourceField = (typeof RECOGNITION_TEXT_PROBE_SUPPORTED_KEYS)[number];

const STORED_ITEM_FIELD_KEYS = [
  'sourceIndex',
  'review_source_index',
  'quantity',
  'unitPrice',
  'unit_price',
  'lineTotal',
  'line_total',
  'grossLineAmount',
  'gross_line_amount',
  'effectiveLineAmount',
  'effective_line_amount',
  'effectiveLineTotal',
  'name',
  'raw_name',
  'kind',
  'discountAllocated',
  'amountUserEdited',
] as const;

export type StoredItemFieldKey = (typeof STORED_ITEM_FIELD_KEYS)[number];

export type DiagnosticFieldState =
  | { kind: 'absent' }
  | { kind: 'null' }
  | { kind: 'finite_number'; value: number }
  | { kind: 'non_finite_number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'other_type'; typeofValue: string };

export type StoredItemFields = Record<StoredItemFieldKey, DiagnosticFieldState>;

export type TargetReceiptEvidenceStoredItemProjection = {
  arrayIndex: number;
  fields: StoredItemFields;
};

export type JsonColumnState =
  | { kind: 'column_null' }
  | { kind: 'empty_string' }
  | { kind: 'whitespace_only' }
  | { kind: 'unparseable' }
  | {
      kind: 'parseable';
      shape: 'object' | 'array' | 'primitive';
      primitiveType?: string;
    };

/** Back-compat coarse user_items classification derived from JsonColumnState. */
export type UserItemsJsonRawKind =
  | 'null'
  | 'empty'
  | 'malformed'
  | 'non_array'
  | 'array';

export type TargetReceiptEvidenceDiscount = {
  label: string | null;
  amount: number | null;
  adjacentPrecedingItemIndex: number | null;
  kind: string | null;
  type: string | null;
};

export type TargetReceiptEvidenceRecognition = {
  jsonColumnState: JsonColumnState;
  itemCount: number | null;
  items: TargetReceiptEvidenceStoredItemProjection[];
  discounts: TargetReceiptEvidenceDiscount[];
  reconciliation: Record<string, unknown> | null;
  unboundedTextFieldsOmitted: boolean;
  imageEvidenceOmitted: boolean;
};

export type TargetReceiptEvidenceReviewMeta = {
  /** Independent nested-value states; no alias coalesce between the two keys. */
  review_meta: NestedJsonValueState;
  reviewMeta: NestedJsonValueState;
  quantityEditDetermination: 'cannot_determine_from_review_metadata';
  errorTagsFromReview_meta: string[] | null;
  errorTagsFromReviewMeta: string[] | null;
  allowlistedKeysPresentOnReview_meta: string[];
  allowlistedKeysPresentOnReviewMeta: string[];
};

export type TargetReceiptEvidenceMappingStatus =
  | 'mapped_via_review_source_index'
  | 'cannot_determine';

export type TargetReceiptEvidenceQuantityMapping = {
  status: TargetReceiptEvidenceMappingStatus;
  reviewSourceIndexField: DiagnosticFieldState;
  recognitionArrayIndex: number | null;
  recognitionItemCount: number | null;
};

export type RecognitionTextProbeState =
  | 'absent'
  | 'present_target_found'
  | 'present_target_not_found';

export type TargetReceiptEvidenceRecognitionTextProbe = {
  enabled: boolean;
  /** Exact supported key used, or null when absent. */
  sourceField: RecognitionTextSourceField | null;
  /** Other supported keys that were also present (non-empty string) but not used. */
  alsoPresentSupportedSourceFields: RecognitionTextSourceField[];
  state: RecognitionTextProbeState;
  windowLines: string[];
  maxLines: number;
  maxChars: number;
  /** True when more than one static anchor match exists in the source text. */
  multipleAnchorsDetected: boolean;
};

export type NestedJsonValueState =
  | { kind: 'key_absent' }
  | { kind: 'null' }
  | { kind: 'empty_string' }
  | { kind: 'whitespace_only' }
  | { kind: 'unparseable_string' }
  | {
      kind: 'parseable_string';
      shape: 'object' | 'array' | 'primitive';
      primitiveType?: string;
    }
  | { kind: 'object' }
  | { kind: 'array' }
  | { kind: 'primitive'; primitiveType: string }
  | { kind: 'other_type'; typeofValue: string };

export type TargetReceiptEvidenceQuantityEvidence = {
  primaryFinalSourceIndex: number;
  mapping: TargetReceiptEvidenceQuantityMapping;
  analysisPrimary: TargetReceiptEvidenceStoredItemProjection | null;
  userItemsPrimary: TargetReceiptEvidenceStoredItemProjection | null;
  recognitionMappedNeighborhood: TargetReceiptEvidenceStoredItemProjection[] | null;
  receiptItemsIndex: TargetReceiptEvidencePersistedItem | null;
  recognitionTextProbe: TargetReceiptEvidenceRecognitionTextProbe;
};

export type TargetReceiptEvidencePersistedItemFields = {
  review_source_index: DiagnosticFieldState;
  raw_name: DiagnosticFieldState;
  purchase_quantity: DiagnosticFieldState;
  purchase_unit_price: DiagnosticFieldState;
  line_total: DiagnosticFieldState;
  gross_line_amount: DiagnosticFieldState;
  effective_line_amount: DiagnosticFieldState;
  discount_allocated: DiagnosticFieldState;
  amount_provenance: DiagnosticFieldState;
  item_amount_evidence_state: DiagnosticFieldState;
  price_observation_version: DiagnosticFieldState;
  sku_key: DiagnosticFieldState;
  identity_source: DiagnosticFieldState;
};

export type TargetReceiptEvidencePersistedItem = {
  sourceIndex: number;
  purchaseQuantityOriginDetermination: 'cannot_determine_from_index_row_alone';
  fields: TargetReceiptEvidencePersistedItemFields;
};

export type TargetReceiptEvidencePphDiagnostic = {
  targetMerchantProductId: string | null;
  primarySourceIndex: number;
  receiptId: string;
  indexDerived: {
    purchaseQuantity: number | null;
    grossLineAmount: number | null;
    purchaseUnitPriceStored: number | null;
    grossPurchaseUnitPriceDerived: number | null;
    amountBasis: null;
    qualityLevel: null;
    level2Eligible: null;
    level2RejectReasons: null;
    includeInTrend: null;
    note: 'quality_not_persisted_in_sql_index_derived_only';
  };
};

export type TargetReceiptEvidenceExport = {
  schemaVersion: typeof TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION;
  exportedAt: string;
  app: {
    version: string | null;
    build: string | null;
  };
  targetKey: string;
  targetReceiptId: string;
  sourceIndices: number[];
  primarySourceIndex: number;
  receipt: {
    found: boolean;
    id: string | null;
    createdAt: number | null;
    transactionAt: number | null;
    merchantRaw: string | null;
    merchantNormalized: string | null;
    total: number | null;
    tax: number | null;
    taxIsKnown: number | null;
    currency: string | null;
    userEdited: number | null;
    finalTotal: number | null;
    analysisJsonColumnState: JsonColumnState;
    userItemsJsonColumnState: JsonColumnState;
    userItemsJsonRawKind: UserItemsJsonRawKind;
    userItemsArrayLength: number | null;
    recognitionSnapshotJsonColumnState: JsonColumnState;
    reviewMetaPresent: boolean;
  };
  analysis: {
    jsonColumnState: JsonColumnState;
    items: TargetReceiptEvidenceStoredItemProjection[];
    discounts: TargetReceiptEvidenceDiscount[];
    reconciliation: Record<string, unknown> | null;
  };
  userItems: {
    jsonColumnState: JsonColumnState;
    rawKind: UserItemsJsonRawKind;
    items: TargetReceiptEvidenceStoredItemProjection[];
    primarySourceIndexPresent: boolean;
  };
  recognition: TargetReceiptEvidenceRecognition;
  reviewMeta: TargetReceiptEvidenceReviewMeta;
  persistedReceiptItems: TargetReceiptEvidencePersistedItem[];
  quantityEvidence: TargetReceiptEvidenceQuantityEvidence;
  pphDiagnostic: TargetReceiptEvidencePphDiagnostic;
};

type ReceiptEvidenceRow = {
  id: string;
  created_at?: number | null;
  transaction_at?: number | null;
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  total?: number | null;
  tax?: number | null;
  tax_is_known?: number | null;
  currency?: string | null;
  user_edited?: number | null;
  final_total?: number | null;
  analysis_json: string | null;
  user_items_json: string | null;
  recognition_snapshot_json: string | null;
};

type ReceiptItemEvidenceRow = {
  source_index: number;
  review_source_index?: number | null;
  raw_name: string | null;
  purchase_quantity: number | null;
  purchase_unit_price?: number | null;
  line_total?: number | null;
  gross_line_amount: number | null;
  effective_line_amount: number | null;
  discount_allocated: number | null;
  amount_provenance: string | null;
  item_amount_evidence_state: string | null;
  price_observation_version: number | null;
  sku_key?: string | null;
  identity_source?: string | null;
};

export type TargetReceiptEvidenceDatabase = {
  getFirstAsync<T>(
    source: string,
    params?: unknown
  ): Promise<T | null>;
  getAllAsync<T>(source: string, params?: unknown): Promise<T[]>;
};

const REVIEW_META_ALLOWLIST = [
  'error_tags',
  'errorTags',
  'corrected',
  'reviewedAt',
  'reviewed_at',
] as const;

const RECOGNITION_TEXT_PROBE_ANCHOR = /世界tea|チャイラテ/;
const RECOGNITION_TEXT_PROBE_MAX_LINES = 7;
const RECOGNITION_TEXT_PROBE_MAX_CHARS = 400;
/** ±N lines around the matched anchor (outer MAX_LINES is a hard cap, not a fill target). */
const RECOGNITION_TEXT_PROBE_CONTEXT_LINES = 2;

/** Final exported window length, counting newline separators between lines. */
export function recognitionTextWindowJoinedLength(windowLines: readonly string[]): number {
  if (windowLines.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < windowLines.length; i += 1) {
    if (i > 0) total += 1;
    total += windowLines[i]!.length;
  }
  return total;
}

/**
 * Clip a single line so the configured anchor match is preserved within maxChars.
 * Centers a bounded window on the first regex match; never takes only a leading prefix
 * that could drop the match.
 */
export function clipRecognitionTextLinePreservingAnchor(
  line: string,
  maxChars: number
): string {
  if (maxChars <= 0) return '';
  if (line.length <= maxChars) return line;
  const match = RECOGNITION_TEXT_PROBE_ANCHOR.exec(line);
  if (!match || match.index == null) {
    return line.slice(0, maxChars);
  }
  const matchStart = match.index;
  const matchText = match[0]!;
  const matchEnd = matchStart + matchText.length;
  if (matchText.length >= maxChars) {
    return matchText.slice(0, maxChars);
  }
  let start = matchStart - Math.floor((maxChars - matchText.length) / 2);
  start = Math.max(0, Math.min(start, line.length - maxChars));
  if (matchStart < start) start = matchStart;
  if (matchEnd > start + maxChars) start = Math.max(0, matchEnd - maxChars);
  start = Math.max(0, Math.min(start, line.length - maxChars));
  const clipped = line.slice(start, start + maxChars);
  if (!RECOGNITION_TEXT_PROBE_ANCHOR.test(clipped)) {
    return matchText.slice(0, maxChars);
  }
  return clipped;
}

/**
 * Map via review_source_index only when the index is a finite integer in range
 * and the center recognition row exists (non-null). Exported for literal NaN/Infinity tests
 * that cannot survive JSON.stringify.
 */
export function resolveRecognitionMappingFromReviewIndex(
  reviewSourceIndexField: DiagnosticFieldState,
  recognitionItemsRaw: unknown[] | null
): {
  status: TargetReceiptEvidenceMappingStatus;
  recognitionArrayIndex: number | null;
  recognitionItemCount: number | null;
} {
  const recognitionItemCount =
    recognitionItemsRaw != null ? recognitionItemsRaw.length : null;
  const reviewIndex = readFiniteNumberFromField(reviewSourceIndexField);
  const recognitionRowExists =
    recognitionItemsRaw != null &&
    reviewIndex != null &&
    Number.isInteger(reviewIndex) &&
    reviewIndex >= 0 &&
    reviewIndex < recognitionItemsRaw.length &&
    Object.prototype.hasOwnProperty.call(recognitionItemsRaw, reviewIndex) &&
    recognitionItemsRaw[reviewIndex] != null;
  if (recognitionRowExists && reviewIndex != null) {
    return {
      status: 'mapped_via_review_source_index',
      recognitionArrayIndex: reviewIndex,
      recognitionItemCount,
    };
  }
  return {
    status: 'cannot_determine',
    recognitionArrayIndex: null,
    recognitionItemCount,
  };
}

/**
 * Anchor-preserving text window: reserve the matched anchor line first, then add
 * nearer context (±CONTEXT, preferring below then above at each distance) while the
 * joined length (including newlines) stays within MAX_CHARS.
 */
export function buildRecognitionTextWindow(text: string): {
  state: RecognitionTextProbeState;
  windowLines: string[];
  multipleAnchorsDetected: boolean;
} {
  const lines = text.split(/\r?\n/);
  const anchorIndices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (RECOGNITION_TEXT_PROBE_ANCHOR.test(lines[i] ?? '')) {
      anchorIndices.push(i);
    }
  }
  if (anchorIndices.length === 0) {
    return {
      state: 'present_target_not_found',
      windowLines: [],
      multipleAnchorsDetected: false,
    };
  }
  const anchorLineIndex = anchorIndices[0]!;
  const maxChars = RECOGNITION_TEXT_PROBE_MAX_CHARS;
  const maxLines = Math.min(
    RECOGNITION_TEXT_PROBE_MAX_LINES,
    RECOGNITION_TEXT_PROBE_CONTEXT_LINES * 2 + 1
  );

  const included = new Map<number, string>();
  const clippedAnchor = clipRecognitionTextLinePreservingAnchor(
    lines[anchorLineIndex] ?? '',
    maxChars
  );
  included.set(anchorLineIndex, clippedAnchor);

  const orderedContextIndices: number[] = [];
  for (let d = 1; d <= RECOGNITION_TEXT_PROBE_CONTEXT_LINES; d += 1) {
    const below = anchorLineIndex + d;
    const above = anchorLineIndex - d;
    if (below < lines.length) orderedContextIndices.push(below);
    if (above >= 0) orderedContextIndices.push(above);
  }

  const joinedLengthOf = (map: Map<number, string>): number => {
    const idxs = [...map.keys()].sort((a, b) => a - b);
    return recognitionTextWindowJoinedLength(idxs.map((i) => map.get(i)!));
  };

  for (const idx of orderedContextIndices) {
    if (included.size >= maxLines) break;
    const currentLen = joinedLengthOf(included);
    const remaining = maxChars - currentLen;
    // Need room for a separating newline plus at least one character.
    if (remaining < 2) break;
    const available = remaining - 1;
    const raw = lines[idx] ?? '';
    let fragment: string;
    if (raw.length <= available) {
      fragment = raw;
    } else if (idx < anchorLineIndex) {
      // Preceding context: keep the suffix nearest the anchor.
      fragment = raw.slice(raw.length - available);
    } else {
      // Following context: keep the prefix nearest the anchor.
      fragment = raw.slice(0, available);
    }
    if (fragment.length === 0) continue;
    included.set(idx, fragment);
  }

  const sortedIdxs = [...included.keys()].sort((a, b) => a - b);
  const windowLines = sortedIdxs.map((i) => included.get(i)!);
  // Invariant: present_target_found ⇒ exported window still matches the anchor.
  if (!windowLines.some((line) => RECOGNITION_TEXT_PROBE_ANCHOR.test(line))) {
    return {
      state: 'present_target_found',
      windowLines: [
        clipRecognitionTextLinePreservingAnchor(
          lines[anchorLineIndex] ?? '',
          maxChars
        ),
      ],
      multipleAnchorsDetected: anchorIndices.length > 1,
    };
  }
  return {
    state: 'present_target_found',
    windowLines,
    multipleAnchorsDetected: anchorIndices.length > 1,
  };
}


/**
 * Runtime fail-closed resolver: only known static target keys.
 * Accepts string so invalid runtime values cannot silently coerce.
 * Returns a detached copy — mutating the result cannot alter authority.
 */
export function resolveTargetReceiptEvidenceSpec(
  targetKey: string
): TargetReceiptEvidenceSpec {
  if (
    typeof targetKey !== 'string' ||
    !Object.prototype.hasOwnProperty.call(
      TARGET_RECEIPT_EVIDENCE_SPECS,
      targetKey
    )
  ) {
    throw new UnknownTargetReceiptEvidenceTargetKeyError(String(targetKey));
  }
  const key = targetKey as TargetReceiptEvidenceTargetKey;
  const spec = TARGET_RECEIPT_EVIDENCE_SPECS[key];
  return {
    key: spec.key,
    receiptId: spec.receiptId,
    sourceIndices: [...spec.sourceIndices],
    filenameSlug: spec.filenameSlug,
    primarySourceIndex: spec.primarySourceIndex,
    diagnosticMerchantProductId: spec.diagnosticMerchantProductId,
  };
}

export function buildTargetReceiptSelectSql(): string {
  return `
SELECT
  id,
  created_at,
  transaction_at,
  merchant_raw,
  merchant_normalized,
  total,
  tax,
  tax_is_known,
  currency,
  user_edited,
  final_total,
  analysis_json,
  user_items_json,
  recognition_snapshot_json
FROM receipts
WHERE id = ?
`.trim();
}

function buildTargetReceiptItemsSelectSql(
  sourceIndices: readonly number[]
): string {
  if (sourceIndices.length === 0) {
    throw new Error('target_receipt_evidence_empty_source_indices');
  }
  for (const index of sourceIndices) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`target_receipt_evidence_invalid_source_index:${index}`);
    }
  }
  const placeholders = sourceIndices.map(() => '?').join(', ');
  return `
SELECT
  source_index,
  review_source_index,
  raw_name,
  purchase_quantity,
  purchase_unit_price,
  line_total,
  gross_line_amount,
  effective_line_amount,
  discount_allocated,
  amount_provenance,
  item_amount_evidence_state,
  price_observation_version,
  sku_key,
  identity_source
FROM receipt_items
WHERE receipt_id = ?
  AND source_index IN (${placeholders})
ORDER BY source_index ASC
`.trim();
}

/** SELECT-only items SQL for a static target key. */
export function buildTargetReceiptItemsSelectSqlForTarget(
  targetKey: string
): string {
  const spec = resolveTargetReceiptEvidenceSpec(targetKey);
  return buildTargetReceiptItemsSelectSql(spec.sourceIndices);
}

/** Auq back-compat SQL constants (SELECT-only). */
export const TARGET_RECEIPT_SELECT_SQL = buildTargetReceiptSelectSql();

export const TARGET_RECEIPT_ITEMS_SELECT_SQL =
  buildTargetReceiptItemsSelectSqlForTarget('auq_poultry');

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function diagnosticFieldFromValue(value: unknown): DiagnosticFieldState {
  if (value === undefined) return { kind: 'absent' };
  if (value === null) return { kind: 'null' };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { kind: 'finite_number', value }
      : { kind: 'non_finite_number', value };
  }
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  return { kind: 'other_type', typeofValue: typeof value };
}

/** Absent when key is not present on the object (including inherited). */
export function readDiagnosticField(
  obj: Record<string, unknown> | null | undefined,
  key: string
): DiagnosticFieldState {
  if (!obj || !Object.prototype.hasOwnProperty.call(obj, key)) {
    return { kind: 'absent' };
  }
  return diagnosticFieldFromValue(obj[key]);
}

function emptyStoredItemFields(): StoredItemFields {
  const fields = {} as StoredItemFields;
  for (const key of STORED_ITEM_FIELD_KEYS) {
    fields[key] = { kind: 'absent' };
  }
  return fields;
}

function projectStoredItemAtArrayIndex(
  raw: unknown,
  arrayIndex: number
): TargetReceiptEvidenceStoredItemProjection {
  const obj = asRecord(raw);
  if (!obj) {
    return { arrayIndex, fields: emptyStoredItemFields() };
  }
  const fields = {} as StoredItemFields;
  for (const key of STORED_ITEM_FIELD_KEYS) {
    fields[key] = readDiagnosticField(obj, key);
  }
  return { arrayIndex, fields };
}

function projectStoredItemsAtIndices(
  itemsRaw: unknown,
  sourceIndices: readonly number[]
): TargetReceiptEvidenceStoredItemProjection[] {
  const list = Array.isArray(itemsRaw) ? itemsRaw : [];
  return sourceIndices.map((arrayIndex) => {
    if (arrayIndex < list.length) {
      return projectStoredItemAtArrayIndex(list[arrayIndex], arrayIndex);
    }
    return { arrayIndex, fields: emptyStoredItemFields() };
  });
}

function readFiniteNumberFromField(state: DiagnosticFieldState): number | null {
  return state.kind === 'finite_number' ? state.value : null;
}

export function classifyJsonColumnState(
  raw: string | null | undefined
): JsonColumnState {
  if (raw == null) return { kind: 'column_null' };
  if (typeof raw !== 'string') return { kind: 'unparseable' };
  if (raw.length === 0) return { kind: 'empty_string' };
  if (!raw.trim()) return { kind: 'whitespace_only' };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { kind: 'parseable', shape: 'array' };
    }
    if (parsed && typeof parsed === 'object') {
      return { kind: 'parseable', shape: 'object' };
    }
    return {
      kind: 'parseable',
      shape: 'primitive',
      primitiveType: typeof parsed,
    };
  } catch {
    return { kind: 'unparseable' };
  }
}

export function jsonColumnStateToUserItemsRawKind(
  state: JsonColumnState
): UserItemsJsonRawKind {
  switch (state.kind) {
    case 'column_null':
      return 'null';
    case 'empty_string':
    case 'whitespace_only':
      return 'empty';
    case 'unparseable':
      return 'malformed';
    case 'parseable':
      return state.shape === 'array' ? 'array' : 'non_array';
    default:
      return 'malformed';
  }
}

function parseJsonColumnArray(raw: string | null | undefined): unknown[] | null {
  const state = classifyJsonColumnState(raw);
  if (state.kind !== 'parseable' || state.shape !== 'array') return null;
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonColumnObject(
  raw: string | null | undefined
): Record<string, unknown> | null {
  const state = classifyJsonColumnState(raw);
  if (state.kind !== 'parseable' || state.shape !== 'object') return null;
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function classifyUserItemsJsonRaw(
  raw: string | null | undefined
): {
  rawKind: UserItemsJsonRawKind;
  present: boolean;
  parseableArray: boolean;
  arrayLength: number | null;
  items: unknown[] | null;
  jsonColumnState: JsonColumnState;
} {
  const jsonColumnState = classifyJsonColumnState(raw);
  const rawKind = jsonColumnStateToUserItemsRawKind(jsonColumnState);
  const present = jsonColumnState.kind !== 'column_null';
  const items = parseJsonColumnArray(raw);
  return {
    rawKind,
    present,
    parseableArray: items != null,
    arrayLength: items?.length ?? null,
    items,
    jsonColumnState,
  };
}

export function classifyNestedJsonValueState(
  container: Record<string, unknown> | null | undefined,
  key: string
): NestedJsonValueState {
  if (!container || !Object.prototype.hasOwnProperty.call(container, key)) {
    return { kind: 'key_absent' };
  }
  const raw = container[key];
  if (raw === null) return { kind: 'null' };
  if (typeof raw === 'string') {
    if (raw.length === 0) return { kind: 'empty_string' };
    if (!raw.trim()) return { kind: 'whitespace_only' };
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { kind: 'parseable_string', shape: 'array' };
      }
      if (parsed && typeof parsed === 'object') {
        return { kind: 'parseable_string', shape: 'object' };
      }
      return {
        kind: 'parseable_string',
        shape: 'primitive',
        primitiveType: typeof parsed,
      };
    } catch {
      return { kind: 'unparseable_string' };
    }
  }
  if (Array.isArray(raw)) return { kind: 'array' };
  if (raw && typeof raw === 'object') return { kind: 'object' };
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return { kind: 'primitive', primitiveType: typeof raw };
  }
  return { kind: 'other_type', typeofValue: typeof raw };
}

function nestedReviewMetaObject(
  container: Record<string, unknown> | null,
  key: 'review_meta' | 'reviewMeta'
): Record<string, unknown> | null {
  if (!container || !Object.prototype.hasOwnProperty.call(container, key)) {
    return null;
  }
  const raw = container[key];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function projectReviewMetaAllowlist(obj: Record<string, unknown> | null): {
  allowlistedKeysPresent: string[];
  errorTags: string[] | null;
} {
  if (!obj) {
    return { allowlistedKeysPresent: [], errorTags: null };
  }
  const allowlistedKeysPresent = REVIEW_META_ALLOWLIST.filter(
    (key) => obj[key] !== undefined
  );
  const tagsRaw = obj.error_tags ?? obj.errorTags;
  const errorTags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === 'string')
    : null;
  return { allowlistedKeysPresent: [...allowlistedKeysPresent], errorTags };
}

function projectReviewMeta(
  analysisObj: Record<string, unknown> | null
): TargetReceiptEvidenceReviewMeta {
  const review_metaState = classifyNestedJsonValueState(analysisObj, 'review_meta');
  const reviewMetaState = classifyNestedJsonValueState(analysisObj, 'reviewMeta');
  const snakeObj = nestedReviewMetaObject(analysisObj, 'review_meta');
  const camelObj = nestedReviewMetaObject(analysisObj, 'reviewMeta');
  const snake = projectReviewMetaAllowlist(snakeObj);
  const camel = projectReviewMetaAllowlist(camelObj);
  return {
    review_meta: review_metaState,
    reviewMeta: reviewMetaState,
    quantityEditDetermination: 'cannot_determine_from_review_metadata',
    errorTagsFromReview_meta: snake.errorTags,
    errorTagsFromReviewMeta: camel.errorTags,
    allowlistedKeysPresentOnReview_meta: snake.allowlistedKeysPresent,
    allowlistedKeysPresentOnReviewMeta: camel.allowlistedKeysPresent,
  };
}

function projectDiscounts(raw: unknown): TargetReceiptEvidenceDiscount[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const d = asRecord(row) ?? {};
    const adj = d.adjacentPrecedingItemIndex;
    return {
      label: readNullableString(d.label),
      amount: readNullableNumber(d.amount),
      adjacentPrecedingItemIndex:
        typeof adj === 'number' && Number.isInteger(adj) ? adj : null,
      kind: readNullableString(d.kind),
      type: readNullableString(d.type),
    };
  });
}

function projectReconciliation(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of RECONCILIATION_ALLOWLIST) {
    if (src[key] !== undefined) picked[key] = src[key];
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

function projectRecognitionNeighborhood(
  itemsRaw: unknown[],
  centerIndex: number
): TargetReceiptEvidenceStoredItemProjection[] {
  const indices = [
    centerIndex - 1,
    centerIndex,
    centerIndex + 1,
  ].filter((i) => i >= 0 && i < itemsRaw.length);
  return indices.map((i) => projectStoredItemAtArrayIndex(itemsRaw[i], i));
}

function resolveRecognitionTextBlob(
  recognitionObj: Record<string, unknown> | null
): {
  sourceField: RecognitionTextSourceField | null;
  alsoPresentSupportedSourceFields: RecognitionTextSourceField[];
  text: string | null;
} {
  if (!recognitionObj) {
    return {
      sourceField: null,
      alsoPresentSupportedSourceFields: [],
      text: null,
    };
  }
  const presentNonEmpty: RecognitionTextSourceField[] = [];
  for (const key of RECOGNITION_TEXT_PROBE_SUPPORTED_KEYS) {
    const value = recognitionObj[key];
    if (typeof value === 'string' && value.length > 0) {
      presentNonEmpty.push(key);
    }
  }
  if (presentNonEmpty.length === 0) {
    return {
      sourceField: null,
      alsoPresentSupportedSourceFields: [],
      text: null,
    };
  }
  const sourceField = presentNonEmpty[0]!;
  const text = recognitionObj[sourceField];
  return {
    sourceField,
    alsoPresentSupportedSourceFields: presentNonEmpty.slice(1),
    text: typeof text === 'string' ? text : null,
  };
}

function buildRecognitionTextProbe(args: {
  targetKey: TargetReceiptEvidenceTargetKey;
  recognitionRaw: string | null | undefined;
}): TargetReceiptEvidenceRecognitionTextProbe {
  const disabled: TargetReceiptEvidenceRecognitionTextProbe = {
    enabled: false,
    sourceField: null,
    alsoPresentSupportedSourceFields: [],
    state: 'absent',
    windowLines: [],
    maxLines: RECOGNITION_TEXT_PROBE_MAX_LINES,
    maxChars: RECOGNITION_TEXT_PROBE_MAX_CHARS,
    multipleAnchorsDetected: false,
  };
  if (args.targetKey !== 'receipt061_aeon_quantity') {
    return disabled;
  }
  const recognitionObj = parseJsonColumnObject(args.recognitionRaw);
  const resolved = resolveRecognitionTextBlob(recognitionObj);
  if (resolved.sourceField == null || resolved.text == null) {
    return {
      enabled: true,
      sourceField: null,
      alsoPresentSupportedSourceFields: [],
      state: 'absent',
      windowLines: [],
      maxLines: RECOGNITION_TEXT_PROBE_MAX_LINES,
      maxChars: RECOGNITION_TEXT_PROBE_MAX_CHARS,
      multipleAnchorsDetected: false,
    };
  }
  const window = buildRecognitionTextWindow(resolved.text);
  return {
    enabled: true,
    sourceField: resolved.sourceField,
    alsoPresentSupportedSourceFields: resolved.alsoPresentSupportedSourceFields,
    state: window.state,
    windowLines: window.windowLines,
    maxLines: RECOGNITION_TEXT_PROBE_MAX_LINES,
    maxChars: RECOGNITION_TEXT_PROBE_MAX_CHARS,
    multipleAnchorsDetected: window.multipleAnchorsDetected,
  };
}

function projectRecognitionSnapshot(
  raw: string | null | undefined,
  _finalSourceIndices: readonly number[]
): TargetReceiptEvidenceRecognition {
  const jsonColumnState = classifyJsonColumnState(raw);
  const empty: TargetReceiptEvidenceRecognition = {
    jsonColumnState,
    itemCount: null,
    // Recognition row identity is via quantityEvidence.mapping + neighborhood —
    // never equate final sourceIndices with recognition array positions.
    items: [],
    discounts: [],
    reconciliation: null,
    unboundedTextFieldsOmitted: false,
    imageEvidenceOmitted: false,
  };
  if (
    jsonColumnState.kind === 'column_null' ||
    jsonColumnState.kind === 'empty_string' ||
    jsonColumnState.kind === 'whitespace_only' ||
    jsonColumnState.kind === 'unparseable'
  ) {
    return empty;
  }
  if (jsonColumnState.kind === 'parseable' && jsonColumnState.shape !== 'object') {
    return empty;
  }
  const obj = parseJsonColumnObject(raw);
  if (!obj) {
    return { ...empty, jsonColumnState: { kind: 'unparseable' } };
  }
  const unboundedTextFieldsOmitted = RECOGNITION_RAW_TEXT_TOP_LEVEL_KEYS.some(
    (key) => obj[key] !== undefined
  );
  const imageEvidenceOmitted = RECOGNITION_IMAGE_TOP_LEVEL_KEYS.some(
    (key) => obj[key] !== undefined
  );
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  return {
    jsonColumnState,
    itemCount: itemsRaw.length,
    items: [],
    discounts: projectDiscounts(obj.discounts),
    reconciliation: projectReconciliation(obj.reconciliation),
    unboundedTextFieldsOmitted,
    imageEvidenceOmitted,
  };
}

function projectPersistedReceiptItem(
  row: ReceiptItemEvidenceRow
): TargetReceiptEvidencePersistedItem {
  return {
    sourceIndex: row.source_index,
    purchaseQuantityOriginDetermination:
      'cannot_determine_from_index_row_alone',
    fields: {
      review_source_index: diagnosticFieldFromValue(row.review_source_index),
      raw_name: diagnosticFieldFromValue(row.raw_name),
      purchase_quantity: diagnosticFieldFromValue(row.purchase_quantity),
      purchase_unit_price: diagnosticFieldFromValue(row.purchase_unit_price),
      line_total: diagnosticFieldFromValue(row.line_total),
      gross_line_amount: diagnosticFieldFromValue(row.gross_line_amount),
      effective_line_amount: diagnosticFieldFromValue(row.effective_line_amount),
      discount_allocated: diagnosticFieldFromValue(row.discount_allocated),
      amount_provenance: diagnosticFieldFromValue(row.amount_provenance),
      item_amount_evidence_state: diagnosticFieldFromValue(
        row.item_amount_evidence_state
      ),
      price_observation_version: diagnosticFieldFromValue(
        row.price_observation_version
      ),
      sku_key: diagnosticFieldFromValue(row.sku_key),
      identity_source: diagnosticFieldFromValue(row.identity_source),
    },
  };
}

function findStoredProjectionAtIndex(
  items: readonly TargetReceiptEvidenceStoredItemProjection[],
  arrayIndex: number
): TargetReceiptEvidenceStoredItemProjection | null {
  return items.find((item) => item.arrayIndex === arrayIndex) ?? null;
}

function findPersistedItem(
  items: readonly TargetReceiptEvidencePersistedItem[],
  sourceIndex: number
): TargetReceiptEvidencePersistedItem | null {
  return items.find((item) => item.sourceIndex === sourceIndex) ?? null;
}

function buildQuantityEvidence(args: {
  targetKey: TargetReceiptEvidenceTargetKey;
  primaryFinalSourceIndex: number;
  analysisItems: TargetReceiptEvidenceStoredItemProjection[];
  userItems: TargetReceiptEvidenceStoredItemProjection[];
  userItemsParseableArray: boolean;
  recognitionItemsRaw: unknown[] | null;
  persisted: TargetReceiptEvidencePersistedItem[];
  recognitionRaw: string | null | undefined;
}): TargetReceiptEvidenceQuantityEvidence {
  const primary = args.primaryFinalSourceIndex;
  const analysisPrimary = findStoredProjectionAtIndex(args.analysisItems, primary);
  const userItemsPrimary =
    args.userItemsParseableArray
      ? findStoredProjectionAtIndex(args.userItems, primary)
      : null;

  const reviewSourceIndexField =
    analysisPrimary?.fields.review_source_index ?? { kind: 'absent' as const };
  const mappingResolved = resolveRecognitionMappingFromReviewIndex(
    reviewSourceIndexField,
    args.recognitionItemsRaw
  );

  let recognitionMappedNeighborhood: TargetReceiptEvidenceStoredItemProjection[] | null =
    null;
  if (
    mappingResolved.status === 'mapped_via_review_source_index' &&
    mappingResolved.recognitionArrayIndex != null &&
    args.recognitionItemsRaw
  ) {
    recognitionMappedNeighborhood = projectRecognitionNeighborhood(
      args.recognitionItemsRaw,
      mappingResolved.recognitionArrayIndex
    );
  }

  const receiptItemsIndex = findPersistedItem(args.persisted, primary);

  return {
    primaryFinalSourceIndex: primary,
    mapping: {
      status: mappingResolved.status,
      reviewSourceIndexField,
      recognitionArrayIndex: mappingResolved.recognitionArrayIndex,
      recognitionItemCount: mappingResolved.recognitionItemCount,
    },
    analysisPrimary,
    userItemsPrimary,
    recognitionMappedNeighborhood,
    receiptItemsIndex,
    recognitionTextProbe: buildRecognitionTextProbe({
      targetKey: args.targetKey,
      recognitionRaw: args.recognitionRaw,
    }),
  };
}

function buildPphDiagnostic(args: {
  targetMerchantProductId: string | null;
  primarySourceIndex: number;
  receiptId: string;
  persisted: TargetReceiptEvidencePersistedItem[];
}): TargetReceiptEvidencePphDiagnostic {
  const row = findPersistedItem(args.persisted, args.primarySourceIndex);
  const purchaseQuantity =
    row != null &&
    row.fields.purchase_quantity.kind === 'finite_number'
      ? row.fields.purchase_quantity.value
      : null;
  const grossLineAmount =
    row != null &&
    row.fields.gross_line_amount.kind === 'finite_number'
      ? row.fields.gross_line_amount.value
      : null;
  const purchaseUnitPriceStored =
    row != null &&
    row.fields.purchase_unit_price.kind === 'finite_number'
      ? row.fields.purchase_unit_price.value
      : null;

  let grossPurchaseUnitPriceDerived: number | null = null;
  if (
    purchaseQuantity != null &&
    purchaseQuantity > 0 &&
    grossLineAmount != null &&
    grossLineAmount > 0 &&
    Number.isFinite(purchaseQuantity) &&
    Number.isFinite(grossLineAmount)
  ) {
    grossPurchaseUnitPriceDerived = grossLineAmount / purchaseQuantity;
  }

  return {
    targetMerchantProductId: args.targetMerchantProductId,
    primarySourceIndex: args.primarySourceIndex,
    receiptId: args.receiptId,
    indexDerived: {
      purchaseQuantity,
      grossLineAmount,
      purchaseUnitPriceStored,
      grossPurchaseUnitPriceDerived,
      amountBasis: null,
      qualityLevel: null,
      level2Eligible: null,
      level2RejectReasons: null,
      includeInTrend: null,
      note: 'quality_not_persisted_in_sql_index_derived_only',
    },
  };
}

export type PersistedTargetReceiptEvidenceInput = {
  receipt: {
    id: string;
    created_at?: number | null;
    transaction_at?: number | null;
    merchant_raw?: string | null;
    merchant_normalized?: string | null;
    total?: number | null;
    tax?: number | null;
    tax_is_known?: number | null;
    currency?: string | null;
    user_edited?: number | null;
    final_total?: number | null;
    analysis_json: string | null;
    user_items_json: string | null;
    recognition_snapshot_json: string | null;
  } | null;
  persistedItemRows: readonly ReceiptItemEvidenceRow[];
  nowMs?: number;
  app?: { version?: string | null; build?: string | null };
};

/**
 * Pure projection for a static target key only.
 * Does not call monetary recovery / enrichment.
 * Does not accept caller-supplied receiptId / sourceIndices.
 */
export function buildTargetReceiptEvidenceExport(
  targetKey: string,
  input: PersistedTargetReceiptEvidenceInput
): TargetReceiptEvidenceExport {
  const spec = resolveTargetReceiptEvidenceSpec(targetKey);
  const sourceIndices = [...spec.sourceIndices];
  const primarySourceIndex = spec.primarySourceIndex;
  const nowMs = input.nowMs ?? Date.now();
  const receipt = input.receipt;

  const analysisJsonColumnState = classifyJsonColumnState(receipt?.analysis_json);
  const analysisObj = parseJsonColumnObject(receipt?.analysis_json);

  const userClass = classifyUserItemsJsonRaw(receipt?.user_items_json);
  const recognitionSnapshotJsonColumnState = classifyJsonColumnState(
    receipt?.recognition_snapshot_json
  );
  const recognitionObj = parseJsonColumnObject(receipt?.recognition_snapshot_json);
  const recognitionItemsRaw = Array.isArray(recognitionObj?.items)
    ? recognitionObj.items
    : null;

  const recognition = projectRecognitionSnapshot(
    receipt?.recognition_snapshot_json,
    sourceIndices
  );
  const reviewMeta = projectReviewMeta(analysisObj);

  const analysisItems = projectStoredItemsAtIndices(
    analysisObj?.items,
    sourceIndices
  );
  const discounts = projectDiscounts(analysisObj?.discounts);
  const reconciliation = projectReconciliation(analysisObj?.reconciliation);

  const userItemsProjected = projectStoredItemsAtIndices(
    userClass.items,
    sourceIndices
  );

  const indexSet = new Set(sourceIndices);
  const persistedReceiptItems: TargetReceiptEvidencePersistedItem[] = [
    ...input.persistedItemRows,
  ]
    .filter((row) => indexSet.has(row.source_index))
    .sort((a, b) => a.source_index - b.source_index)
    .map(projectPersistedReceiptItem);

  const primarySourceIndexPresent =
    userClass.parseableArray &&
    primarySourceIndex < (userClass.arrayLength ?? 0);

  const quantityEvidence = buildQuantityEvidence({
    targetKey: spec.key,
    primaryFinalSourceIndex: primarySourceIndex,
    analysisItems,
    userItems: userItemsProjected,
    userItemsParseableArray: userClass.parseableArray,
    recognitionItemsRaw,
    persisted: persistedReceiptItems,
    recognitionRaw: receipt?.recognition_snapshot_json,
  });

  const pphDiagnostic = buildPphDiagnostic({
    targetMerchantProductId: spec.diagnosticMerchantProductId,
    primarySourceIndex,
    receiptId: spec.receiptId,
    persisted: persistedReceiptItems,
  });

  return {
    schemaVersion: TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    app: {
      version: input.app?.version ?? null,
      build: input.app?.build ?? null,
    },
    targetKey: spec.key,
    targetReceiptId: spec.receiptId,
    sourceIndices,
    primarySourceIndex,
    receipt: {
      found: receipt != null,
      id: receipt?.id ?? null,
      createdAt: readNullableNumber(receipt?.created_at),
      transactionAt: readNullableNumber(receipt?.transaction_at),
      merchantRaw: readNullableString(receipt?.merchant_raw),
      merchantNormalized: readNullableString(receipt?.merchant_normalized),
      total: readNullableNumber(receipt?.total),
      tax: readNullableNumber(receipt?.tax),
      taxIsKnown: readNullableNumber(receipt?.tax_is_known),
      currency: readNullableString(receipt?.currency),
      userEdited: readNullableNumber(receipt?.user_edited),
      finalTotal: readNullableNumber(receipt?.final_total),
      analysisJsonColumnState,
      userItemsJsonColumnState: userClass.jsonColumnState,
      userItemsJsonRawKind: userClass.rawKind,
      userItemsArrayLength: userClass.arrayLength,
      recognitionSnapshotJsonColumnState,
      reviewMetaPresent:
        reviewMeta.review_meta.kind !== 'key_absent' ||
        reviewMeta.reviewMeta.kind !== 'key_absent',
    },
    analysis: {
      jsonColumnState: analysisJsonColumnState,
      items: analysisItems,
      discounts,
      reconciliation,
    },
    userItems: {
      jsonColumnState: userClass.jsonColumnState,
      rawKind: userClass.rawKind,
      items: userItemsProjected,
      primarySourceIndexPresent,
    },
    recognition,
    reviewMeta,
    persistedReceiptItems,
    quantityEvidence,
    pphDiagnostic,
  };
}

function walkExportObjectKeys(
  value: unknown,
  visit: (key: string) => void
): void {
  if (value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) walkExportObjectKeys(entry, visit);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key);
    if (
      ALLOWED_SOURCE_FIELD_METADATA_KEYS.has(key) &&
      (typeof child === 'string' || Array.isArray(child))
    ) {
      // sourceField / alsoPresent may name supported OCR keys as values only.
      continue;
    }
    walkExportObjectKeys(child, visit);
  }
}

export function assertTargetReceiptEvidenceJsonSafe(
  payload: TargetReceiptEvidenceExport
): void {
  const json = JSON.stringify(payload);
  for (const needle of TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS) {
    if (json.includes(needle)) {
      throw new Error(
        `target_receipt_evidence_forbidden_field:${needle}`
      );
    }
  }
  // Forbid dumping OCR/text blob fields as object keys; metadata values may name keys.
  walkExportObjectKeys(payload, (key) => {
    if (FORBIDDEN_EXPORT_OBJECT_KEYS.has(key)) {
      throw new Error(`target_receipt_evidence_forbidden_object_key:${key}`);
    }
  });
  const probe = payload.quantityEvidence.recognitionTextProbe;
  const windowText = probe.windowLines.join('\n');
  if (windowText.length > probe.maxChars) {
    throw new Error('target_receipt_evidence_text_probe_char_limit_exceeded');
  }
  if (recognitionTextWindowJoinedLength(probe.windowLines) > probe.maxChars) {
    throw new Error('target_receipt_evidence_text_probe_joined_char_limit_exceeded');
  }
  if (probe.windowLines.length > probe.maxLines) {
    throw new Error('target_receipt_evidence_text_probe_line_limit_exceeded');
  }
  if (
    probe.state === 'present_target_found' &&
    !probe.windowLines.some((line) => /世界tea|チャイラテ/.test(line))
  ) {
    throw new Error('target_receipt_evidence_text_probe_anchor_missing');
  }
}

/**
 * Observational load: SELECT-only against an already-initialized DB.
 */
export async function loadTargetReceiptEvidenceWithDb(
  db: TargetReceiptEvidenceDatabase,
  options?: {
    targetKey?: string;
    nowMs?: number;
    app?: { version?: string | null; build?: string | null };
  }
): Promise<TargetReceiptEvidenceExport> {
  const targetKey = options?.targetKey ?? 'auq_poultry';
  const spec = resolveTargetReceiptEvidenceSpec(targetKey);
  const selectSql = buildTargetReceiptSelectSql();
  const itemsSql = buildTargetReceiptItemsSelectSql(spec.sourceIndices);
  const receipt = await db.getFirstAsync<ReceiptEvidenceRow>(selectSql, [
    spec.receiptId,
  ]);
  const persistedItemRows = await db.getAllAsync<ReceiptItemEvidenceRow>(
    itemsSql,
    [spec.receiptId, ...spec.sourceIndices]
  );
  return buildTargetReceiptEvidenceExport(targetKey, {
    receipt,
    persistedItemRows: persistedItemRows ?? [],
    nowMs: options?.nowMs,
    app: options?.app,
  });
}

export async function buildTargetReceiptEvidenceFromLocalDb(options?: {
  targetKey?: string;
  nowMs?: number;
  app?: { version?: string | null; build?: string | null };
  requireInitializedDb?: () => TargetReceiptEvidenceDatabase;
}): Promise<TargetReceiptEvidenceExport> {
  const requireDb =
    options?.requireInitializedDb ?? getInitializedReceiptsDatabaseOrThrow;
  const db = requireDb();
  return loadTargetReceiptEvidenceWithDb(db, {
    targetKey: options?.targetKey,
    nowMs: options?.nowMs,
    app: options?.app,
  });
}

export function buildTargetReceiptEvidenceFilename(
  nowMs: number = Date.now(),
  filenameSlug: string = TARGET_RECEIPT_EVIDENCE_SPECS.auq_poultry.filenameSlug
): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `target-receipt-evidence-${filenameSlug}-${stamp}.json`;
}

export async function writeTargetReceiptEvidenceFile(deps: {
  payload: TargetReceiptEvidenceExport;
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  nowMs?: number;
  filenameSlug?: string;
}): Promise<{ fileUri: string; filename: string; json: string }> {
  if (!deps.cacheDirectory) {
    throw new Error(
      'Cache directory unavailable; cannot export target receipt evidence.'
    );
  }
  assertTargetReceiptEvidenceJsonSafe(deps.payload);
  const filename = buildTargetReceiptEvidenceFilename(
    deps.nowMs,
    deps.filenameSlug ?? deps.payload.targetKey
  );
  const json = JSON.stringify(deps.payload, null, 2);
  const fileUri = `${deps.cacheDirectory}${filename}`;
  await deps.writeAsStringAsync(fileUri, json);
  return { fileUri, filename, json };
}

export async function shareTargetReceiptEvidenceFile(deps: {
  fileUri: string;
  filename: string;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (
    url: string,
    options?: {
      mimeType?: string;
      UTI?: string;
      dialogTitle?: string;
    }
  ) => Promise<void>;
}): Promise<void> {
  const available = await deps.isAvailableAsync();
  if (!available) {
    throw new Error(
      'Native file sharing is unavailable on this device. Cannot export target receipt evidence.'
    );
  }
  await deps.shareAsync(deps.fileUri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: deps.filename,
  });
}

function readInstalledAppMeta(): { version: string | null; build: string | null } {
  return { version: null, build: null };
}

/**
 * End-to-end: observational load → write cache → Share Sheet.
 */
export async function exportAndShareTargetReceiptEvidence(deps: {
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: Parameters<typeof shareTargetReceiptEvidenceFile>[0]['shareAsync'];
  nowMs?: number;
  app?: { version?: string | null; build?: string | null };
  targetKey?: string;
  buildExport?: () => Promise<TargetReceiptEvidenceExport>;
}): Promise<{
  fileUri: string;
  filename: string;
  payload: TargetReceiptEvidenceExport;
}> {
  const targetKey = deps.targetKey ?? 'auq_poultry';
  const spec = resolveTargetReceiptEvidenceSpec(targetKey);
  const payload = deps.buildExport
    ? await deps.buildExport()
    : await buildTargetReceiptEvidenceFromLocalDb({
        targetKey,
        nowMs: deps.nowMs,
        app: deps.app ?? readInstalledAppMeta(),
      });
  const written = await writeTargetReceiptEvidenceFile({
    payload,
    cacheDirectory: deps.cacheDirectory,
    writeAsStringAsync: deps.writeAsStringAsync,
    nowMs: deps.nowMs,
    filenameSlug: spec.filenameSlug,
  });
  await shareTargetReceiptEvidenceFile({
    fileUri: written.fileUri,
    filename: written.filename,
    isAvailableAsync: deps.isAvailableAsync,
    shareAsync: deps.shareAsync,
  });
  return {
    fileUri: written.fileUri,
    filename: written.filename,
    payload,
  };
}

export { ReceiptsDatabaseNotInitializedError };
