/**
 * Temporary INTERNAL / Validation instrumentation.
 * Read-only SELECT evidence for fixed target receipts only.
 * Does not alter monetary recovery, indexes, or domain semantics.
 */

import {
  getInitializedReceiptsDatabaseOrThrow,
  ReceiptsDatabaseNotInitializedError,
} from './db';

export const TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION = 2 as const;

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
  },
  receipt063_seiyu_inline_markdown: {
    key: 'receipt063_seiyu_inline_markdown',
    receiptId: 'xQCDD8d8OAAewZdYpTs4p',
    sourceIndices: [8, 9] as const,
    filenameSlug: 'receipt063',
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

/** Forbidden broad keys that must never appear in serialized export JSON. */
export const TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS = [
  'image_uri',
  'recognition_snapshot_json',
  'receipts":[',
  'access_token',
  'refresh_token',
  'Authorization',
  'ocr_raw_text',
  '"rawText"',
  '"raw_text"',
  '"fullText"',
] as const;

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

export type UserItemsJsonRawKind =
  | 'null'
  | 'empty'
  | 'malformed'
  | 'non_array'
  | 'array';

export type TargetReceiptEvidenceAnalysisItem = {
  sourceIndex: number;
  name: string | null;
  quantity: number | null;
  lineTotal: number | null;
  line_total: number | null;
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  effectiveLineTotal: number | null;
  discountAllocated: number | null;
  amountUserEdited: boolean | null;
  kind: string | null;
};

export type TargetReceiptEvidenceDiscount = {
  label: string | null;
  amount: number | null;
  adjacentPrecedingItemIndex: number | null;
  /** Existing ownership-relevant kind/type if persisted. */
  kind: string | null;
  type: string | null;
};

export type TargetReceiptEvidencePersistedItem = {
  sourceIndex: number;
  name: string | null;
  quantity: number | null;
  grossLineAmount: number | null;
  effectiveLineAmount: number | null;
  discountAllocated: number | null;
  amountProvenance: string | null;
  itemAmountEvidenceState: string | null;
  priceObservationVersion: number | null;
};

export type TargetReceiptEvidenceRecognition = {
  present: boolean;
  parseable: boolean;
  itemCount: number | null;
  items: TargetReceiptEvidenceAnalysisItem[];
  discounts: TargetReceiptEvidenceDiscount[];
  reconciliation: Record<string, unknown> | null;
  /** True when snapshot had unbounded OCR/text top-level keys (values omitted). */
  unboundedTextFieldsOmitted: boolean;
  /** True when snapshot had image-related top-level keys (values omitted). */
  imageEvidenceOmitted: boolean;
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
  receipt: {
    found: boolean;
    analysisJsonPresent: boolean;
    analysisJsonParseable: boolean;
    userItemsJsonPresent: boolean;
    userItemsJsonParseableArray: boolean;
    userItemsJsonRawKind: UserItemsJsonRawKind;
    userItemsArrayLength: number | null;
    recognitionSnapshotPresent: boolean;
    recognitionSnapshotParseable: boolean;
  };
  analysis: {
    items: TargetReceiptEvidenceAnalysisItem[];
    discounts: TargetReceiptEvidenceDiscount[];
    reconciliation: Record<string, unknown> | null;
  };
  userItems: {
    present: boolean;
    parseableArray: boolean;
    rawKind: UserItemsJsonRawKind;
    items: TargetReceiptEvidenceAnalysisItem[];
  };
  recognition: TargetReceiptEvidenceRecognition;
  persistedReceiptItems: TargetReceiptEvidencePersistedItem[];
};

type ReceiptEvidenceRow = {
  id: string;
  analysis_json: string | null;
  user_items_json: string | null;
  recognition_snapshot_json: string | null;
};

type ReceiptItemEvidenceRow = {
  source_index: number;
  raw_name: string | null;
  purchase_quantity: number | null;
  gross_line_amount: number | null;
  effective_line_amount: number | null;
  discount_allocated: number | null;
  amount_provenance: string | null;
  item_amount_evidence_state: string | null;
  price_observation_version: number | null;
};

export type TargetReceiptEvidenceDatabase = {
  getFirstAsync<T>(
    source: string,
    params?: unknown
  ): Promise<T | null>;
  getAllAsync<T>(source: string, params?: unknown): Promise<T[]>;
};

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
  };
}

export function buildTargetReceiptSelectSql(): string {
  return `
SELECT id, analysis_json, user_items_json, recognition_snapshot_json
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
  raw_name,
  purchase_quantity,
  gross_line_amount,
  effective_line_amount,
  discount_allocated,
  amount_provenance,
  item_amount_evidence_state,
  price_observation_version
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

function readNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function projectAnalysisItem(
  raw: unknown,
  sourceIndex: number
): TargetReceiptEvidenceAnalysisItem {
  const item = asRecord(raw) ?? {};
  const lineTotal =
    readNullableNumber(item.lineTotal) ?? readNullableNumber(item.line_total);
  const effectiveLineTotal =
    readNullableNumber(item.effectiveLineTotal) ??
    readNullableNumber(item.effective_line_total);
  return {
    sourceIndex,
    name: readNullableString(item.name) ?? readNullableString(item.raw_name),
    quantity: readNullableNumber(item.quantity),
    lineTotal,
    line_total: readNullableNumber(item.line_total),
    grossLineAmount:
      readNullableNumber(item.grossLineAmount) ??
      readNullableNumber(item.gross_line_amount) ??
      lineTotal,
    effectiveLineAmount:
      readNullableNumber(item.effectiveLineAmount) ??
      readNullableNumber(item.effective_line_amount) ??
      effectiveLineTotal,
    effectiveLineTotal,
    discountAllocated: readNullableNumber(item.discountAllocated),
    amountUserEdited: readNullableBoolean(item.amountUserEdited),
    kind: readNullableString(item.kind),
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

function projectItemsAtIndices(
  itemsRaw: unknown,
  sourceIndices: readonly number[]
): TargetReceiptEvidenceAnalysisItem[] {
  const list = Array.isArray(itemsRaw) ? itemsRaw : [];
  const out: TargetReceiptEvidenceAnalysisItem[] = [];
  for (const index of sourceIndices) {
    if (index < list.length) {
      out.push(projectAnalysisItem(list[index], index));
    }
  }
  return out;
}

export function classifyUserItemsJsonRaw(
  raw: string | null | undefined
): {
  rawKind: UserItemsJsonRawKind;
  present: boolean;
  parseableArray: boolean;
  arrayLength: number | null;
  items: unknown[] | null;
} {
  if (raw == null) {
    return {
      rawKind: 'null',
      present: false,
      parseableArray: false,
      arrayLength: null,
      items: null,
    };
  }
  if (typeof raw !== 'string') {
    return {
      rawKind: 'malformed',
      present: true,
      parseableArray: false,
      arrayLength: null,
      items: null,
    };
  }
  if (!raw.trim()) {
    return {
      rawKind: 'empty',
      present: true,
      parseableArray: false,
      arrayLength: null,
      items: null,
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        rawKind: 'non_array',
        present: true,
        parseableArray: false,
        arrayLength: null,
        items: null,
      };
    }
    return {
      rawKind: 'array',
      present: true,
      parseableArray: true,
      arrayLength: parsed.length,
      items: parsed,
    };
  } catch {
    return {
      rawKind: 'malformed',
      present: true,
      parseableArray: false,
      arrayLength: null,
      items: null,
    };
  }
}

function projectRecognitionSnapshot(
  raw: string | null | undefined,
  sourceIndices: readonly number[]
): TargetReceiptEvidenceRecognition {
  const empty: TargetReceiptEvidenceRecognition = {
    present: false,
    parseable: false,
    itemCount: null,
    items: [],
    discounts: [],
    reconciliation: null,
    unboundedTextFieldsOmitted: false,
    imageEvidenceOmitted: false,
  };
  if (raw == null || typeof raw !== 'string' || !raw.trim()) {
    return empty;
  }
  const present = true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, present: true, parseable: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...empty, present: true, parseable: false };
  }
  const obj = parsed as Record<string, unknown>;
  const unboundedTextFieldsOmitted = RECOGNITION_RAW_TEXT_TOP_LEVEL_KEYS.some(
    (key) => obj[key] !== undefined
  );
  const imageEvidenceOmitted = RECOGNITION_IMAGE_TOP_LEVEL_KEYS.some(
    (key) => obj[key] !== undefined
  );
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  return {
    present,
    parseable: true,
    itemCount: itemsRaw.length,
    items: projectItemsAtIndices(itemsRaw, sourceIndices),
    discounts: projectDiscounts(obj.discounts),
    reconciliation: projectReconciliation(obj.reconciliation),
    unboundedTextFieldsOmitted,
    imageEvidenceOmitted,
  };
}

export type PersistedTargetReceiptEvidenceInput = {
  receipt: {
    id: string;
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
  const nowMs = input.nowMs ?? Date.now();
  const receipt = input.receipt;
  const analysisRaw = receipt?.analysis_json ?? null;
  const analysisPresent =
    typeof analysisRaw === 'string' && analysisRaw.trim().length > 0;
  let analysisParseable = false;
  let analysisObj: Record<string, unknown> | null = null;
  if (analysisPresent && typeof analysisRaw === 'string') {
    try {
      const parsed = JSON.parse(analysisRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        analysisParseable = true;
        analysisObj = parsed as Record<string, unknown>;
      }
    } catch {
      analysisParseable = false;
    }
  }

  const userClass = classifyUserItemsJsonRaw(receipt?.user_items_json);
  const recognition = projectRecognitionSnapshot(
    receipt?.recognition_snapshot_json,
    sourceIndices
  );

  const analysisItems = projectItemsAtIndices(analysisObj?.items, sourceIndices);
  const discounts = projectDiscounts(analysisObj?.discounts);
  const reconciliation = projectReconciliation(analysisObj?.reconciliation);

  const userItemsProjected: TargetReceiptEvidenceAnalysisItem[] = [];
  if (userClass.items) {
    for (const index of sourceIndices) {
      if (index < userClass.items.length) {
        userItemsProjected.push(
          projectAnalysisItem(userClass.items[index], index)
        );
      }
    }
  }

  const indexSet = new Set(sourceIndices);
  const persistedReceiptItems: TargetReceiptEvidencePersistedItem[] = [
    ...input.persistedItemRows,
  ]
    .filter((row) => indexSet.has(row.source_index))
    .sort((a, b) => a.source_index - b.source_index)
    .map((row) => ({
      sourceIndex: row.source_index,
      name: row.raw_name,
      quantity: row.purchase_quantity,
      grossLineAmount: row.gross_line_amount,
      effectiveLineAmount: row.effective_line_amount,
      discountAllocated: row.discount_allocated,
      amountProvenance: row.amount_provenance,
      itemAmountEvidenceState: row.item_amount_evidence_state,
      priceObservationVersion: row.price_observation_version,
    }));

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
    receipt: {
      found: receipt != null,
      analysisJsonPresent: analysisPresent,
      analysisJsonParseable: analysisParseable,
      userItemsJsonPresent: userClass.present,
      userItemsJsonParseableArray: userClass.parseableArray,
      userItemsJsonRawKind: userClass.rawKind,
      userItemsArrayLength: userClass.arrayLength,
      recognitionSnapshotPresent: recognition.present,
      recognitionSnapshotParseable: recognition.parseable,
    },
    analysis: {
      items: analysisItems,
      discounts,
      reconciliation,
    },
    userItems: {
      present: userClass.present,
      parseableArray: userClass.parseableArray,
      rawKind: userClass.rawKind,
      items: userItemsProjected,
    },
    recognition,
    persistedReceiptItems,
  };
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
