/**
 * Temporary INTERNAL / Validation instrumentation.
 * Read-only SELECT evidence for one hard-coded receipt.
 * Does not alter monetary recovery, indexes, or domain semantics.
 */

import {
  getInitializedReceiptsDatabaseOrThrow,
  ReceiptsDatabaseNotInitializedError,
} from './db';

export const TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const TARGET_RECEIPT_EVIDENCE_RECEIPT_ID =
  'auq8r7qU-EN_l38Y2xDea' as const;

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

export type TargetReceiptEvidenceExport = {
  schemaVersion: typeof TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION;
  exportedAt: string;
  app: {
    version: string | null;
    build: string | null;
  };
  targetReceiptId: typeof TARGET_RECEIPT_EVIDENCE_RECEIPT_ID;
  receipt: {
    found: boolean;
    analysisJsonPresent: boolean;
    analysisJsonParseable: boolean;
    userItemsJsonPresent: boolean;
    userItemsJsonParseableArray: boolean;
    userItemsJsonRawKind: UserItemsJsonRawKind;
    userItemsArrayLength: number | null;
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
  persistedReceiptItems: TargetReceiptEvidencePersistedItem[];
};

type ReceiptEvidenceRow = {
  id: string;
  analysis_json: string | null;
  user_items_json: string | null;
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

export const TARGET_RECEIPT_SELECT_SQL = `
SELECT id, analysis_json, user_items_json
FROM receipts
WHERE id = ?
`.trim();

export const TARGET_RECEIPT_ITEMS_SELECT_SQL = `
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
  AND source_index IN (0, 1)
ORDER BY source_index ASC
`.trim();

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
  };
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

/**
 * Pure projection: narrow analysis + user_items + already-fetched raw item rows.
 * Does not call monetary recovery / enrichment.
 */
export function buildTargetReceiptEvidenceExport(input: {
  receipt: ReceiptEvidenceRow | null;
  persistedItemRows: readonly ReceiptItemEvidenceRow[];
  nowMs?: number;
  app?: { version?: string | null; build?: string | null };
}): TargetReceiptEvidenceExport {
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

  const analysisItemsRaw = Array.isArray(analysisObj?.items)
    ? (analysisObj!.items as unknown[])
    : [];
  const analysisItems: TargetReceiptEvidenceAnalysisItem[] = [];
  for (const index of [0, 1] as const) {
    if (index < analysisItemsRaw.length) {
      analysisItems.push(projectAnalysisItem(analysisItemsRaw[index], index));
    }
  }

  const discountsRaw = Array.isArray(analysisObj?.discounts)
    ? (analysisObj!.discounts as unknown[])
    : [];
  const discounts: TargetReceiptEvidenceDiscount[] = discountsRaw.map((row) => {
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

  const reconciliationRaw = analysisObj?.reconciliation;
  let reconciliation: Record<string, unknown> | null = null;
  if (reconciliationRaw && typeof reconciliationRaw === 'object' && !Array.isArray(reconciliationRaw)) {
    const src = reconciliationRaw as Record<string, unknown>;
    const keys = [
      'ok',
      'itemsPositiveSum',
      'discountsSum',
      'tax',
      'total',
      'expectedTotal',
      'diff',
    ] as const;
    const picked: Record<string, unknown> = {};
    for (const key of keys) {
      if (src[key] !== undefined) picked[key] = src[key];
    }
    reconciliation = Object.keys(picked).length > 0 ? picked : null;
  }

  const userItemsProjected: TargetReceiptEvidenceAnalysisItem[] = [];
  if (userClass.items) {
    for (const index of [0, 1] as const) {
      if (index < userClass.items.length) {
        userItemsProjected.push(
          projectAnalysisItem(userClass.items[index], index)
        );
      }
    }
  }

  const persistedReceiptItems: TargetReceiptEvidencePersistedItem[] = [
    ...input.persistedItemRows,
  ]
    .filter((row) => row.source_index === 0 || row.source_index === 1)
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
    targetReceiptId: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
    receipt: {
      found: receipt != null,
      analysisJsonPresent: analysisPresent,
      analysisJsonParseable: analysisParseable,
      userItemsJsonPresent: userClass.present,
      userItemsJsonParseableArray: userClass.parseableArray,
      userItemsJsonRawKind: userClass.rawKind,
      userItemsArrayLength: userClass.arrayLength,
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
    nowMs?: number;
    app?: { version?: string | null; build?: string | null };
  }
): Promise<TargetReceiptEvidenceExport> {
  const receipt = await db.getFirstAsync<ReceiptEvidenceRow>(
    TARGET_RECEIPT_SELECT_SQL,
    [TARGET_RECEIPT_EVIDENCE_RECEIPT_ID]
  );
  const persistedItemRows = await db.getAllAsync<ReceiptItemEvidenceRow>(
    TARGET_RECEIPT_ITEMS_SELECT_SQL,
    [TARGET_RECEIPT_EVIDENCE_RECEIPT_ID]
  );
  return buildTargetReceiptEvidenceExport({
    receipt,
    persistedItemRows: persistedItemRows ?? [],
    nowMs: options?.nowMs,
    app: options?.app,
  });
}

export async function buildTargetReceiptEvidenceFromLocalDb(options?: {
  nowMs?: number;
  app?: { version?: string | null; build?: string | null };
  requireInitializedDb?: () => TargetReceiptEvidenceDatabase;
}): Promise<TargetReceiptEvidenceExport> {
  const requireDb =
    options?.requireInitializedDb ?? getInitializedReceiptsDatabaseOrThrow;
  const db = requireDb();
  return loadTargetReceiptEvidenceWithDb(db, {
    nowMs: options?.nowMs,
    app: options?.app,
  });
}

export function buildTargetReceiptEvidenceFilename(
  nowMs: number = Date.now()
): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `target-receipt-evidence-auq-${stamp}.json`;
}

export async function writeTargetReceiptEvidenceFile(deps: {
  payload: TargetReceiptEvidenceExport;
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  nowMs?: number;
}): Promise<{ fileUri: string; filename: string; json: string }> {
  if (!deps.cacheDirectory) {
    throw new Error(
      'Cache directory unavailable; cannot export target receipt evidence.'
    );
  }
  assertTargetReceiptEvidenceJsonSafe(deps.payload);
  const filename = buildTargetReceiptEvidenceFilename(deps.nowMs);
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
  buildExport?: () => Promise<TargetReceiptEvidenceExport>;
}): Promise<{
  fileUri: string;
  filename: string;
  payload: TargetReceiptEvidenceExport;
}> {
  const payload = deps.buildExport
    ? await deps.buildExport()
    : await buildTargetReceiptEvidenceFromLocalDb({
        nowMs: deps.nowMs,
        app: deps.app ?? readInstalledAppMeta(),
      });
  const written = await writeTargetReceiptEvidenceFile({
    payload,
    cacheDirectory: deps.cacheDirectory,
    writeAsStringAsync: deps.writeAsStringAsync,
    nowMs: deps.nowMs,
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
