/**
 * Map local ReceiptRow → cloud user_receipts upsert payload.
 * JSON TEXT columns must be passed through unchanged (no parse/stringify).
 */
export type LocalReceiptBackupSource = {
  id: string;
  user_id: string | null | undefined;
  installation_id?: string | null;
  transaction_source?: string | null;
  source?: string | null;
  created_at: number;
  transaction_at?: number | null;
  scanned_at?: number | null;
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  merchant_type?: string | null;
  store_raw?: string | null;
  store_normalized?: string | null;
  total: number;
  tax: number;
  tax_is_known?: number | boolean | null;
  currency: string;
  analysis_json: string;
  recognition_snapshot_json?: string | null;
  user_items_json?: string | null;
  user_edited?: number | boolean | null;
  final_total?: number | null;
  final_category?: string | null;
  note?: string | null;
  ocr_request_id?: string | null;
  client_updated_at?: number | null;
};

export type CloudUserReceiptUpsertPayload = {
  id: string;
  user_id: string;
  installation_id: string | null;
  transaction_source: string;
  social_source: string | null;
  created_at: string;
  transaction_at: string | null;
  scanned_at: string | null;
  merchant_raw: string | null;
  merchant_normalized: string | null;
  merchant_type: string | null;
  store_raw: string | null;
  store_normalized: string | null;
  total: number;
  tax: number;
  tax_is_known: boolean;
  currency: string;
  analysis_json: string;
  recognition_snapshot_json: string | null;
  user_items_json: string | null;
  user_edited: boolean;
  final_total: number | null;
  final_category: string | null;
  note: string | null;
  ocr_request_id: string | null;
  client_updated_at: string;
  deleted_at: null;
};

function msToIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function asBool(v: number | boolean | null | undefined): boolean {
  if (typeof v === 'boolean') return v;
  return Number(v) === 1;
}

/**
 * Build cloud upsert payload. Throws if required ownership/evidence missing.
 * Does NOT include image_uri.
 */
export function buildCloudUserReceiptUpsertPayload(
  row: LocalReceiptBackupSource,
  fallbackClientUpdatedAtMs: number = Date.now()
): CloudUserReceiptUpsertPayload {
  const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
  if (!userId) {
    throw new Error('Cannot backup receipt without user_id');
  }
  if (typeof row.analysis_json !== 'string' || !row.analysis_json.trim()) {
    throw new Error('Cannot backup receipt without analysis_json');
  }

  const clientUpdatedAtMs =
    row.client_updated_at != null && Number.isFinite(row.client_updated_at)
      ? Number(row.client_updated_at)
      : fallbackClientUpdatedAtMs;

  return {
    id: row.id,
    user_id: userId,
    installation_id:
      typeof row.installation_id === 'string' && row.installation_id.trim()
        ? row.installation_id.trim()
        : null,
    transaction_source:
      typeof row.transaction_source === 'string' && row.transaction_source.trim()
        ? row.transaction_source.trim()
        : 'receipt_ocr',
    social_source:
      typeof row.source === 'string' && row.source.trim() ? row.source.trim() : null,
    created_at: msToIso(row.created_at) || new Date(0).toISOString(),
    transaction_at: msToIso(row.transaction_at ?? null),
    scanned_at: msToIso(row.scanned_at ?? null),
    merchant_raw: row.merchant_raw ?? null,
    merchant_normalized: row.merchant_normalized ?? null,
    merchant_type: row.merchant_type ?? null,
    store_raw: row.store_raw ?? null,
    store_normalized: row.store_normalized ?? null,
    total: Number(row.total) || 0,
    tax: Number(row.tax) || 0,
    tax_is_known: asBool(row.tax_is_known),
    currency:
      typeof row.currency === 'string' && row.currency.trim()
        ? row.currency.trim()
        : 'JPY',
    // TEXT evidence — exact local string, never re-serialized.
    analysis_json: row.analysis_json,
    recognition_snapshot_json:
      typeof row.recognition_snapshot_json === 'string'
        ? row.recognition_snapshot_json
        : null,
    user_items_json:
      typeof row.user_items_json === 'string' ? row.user_items_json : null,
    user_edited: asBool(row.user_edited),
    final_total:
      row.final_total != null && Number.isFinite(row.final_total)
        ? Number(row.final_total)
        : null,
    final_category:
      typeof row.final_category === 'string' && row.final_category.trim()
        ? row.final_category.trim()
        : null,
    note: typeof row.note === 'string' && row.note.trim() ? row.note.trim() : null,
    ocr_request_id:
      typeof row.ocr_request_id === 'string' && row.ocr_request_id.trim()
        ? row.ocr_request_id.trim()
        : null,
    client_updated_at: msToIso(clientUpdatedAtMs) || new Date().toISOString(),
    deleted_at: null,
  };
}

/** Payload must never contain image_uri. */
export function assertNoImageUriInPayload(payload: Record<string, unknown>): void {
  if ('image_uri' in payload || 'imageUri' in payload) {
    throw new Error('Cloud backup payload must not include image_uri');
  }
}
