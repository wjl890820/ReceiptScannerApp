/**
 * Cloud user_receipts row → local receipts insert values.
 * JSON TEXT columns must pass through unchanged (no parse/stringify).
 */
export type CloudUserReceiptRow = {
  id: string;
  user_id: string;
  installation_id?: string | null;
  transaction_source?: string | null;
  social_source?: string | null;
  created_at: string;
  transaction_at?: string | null;
  scanned_at?: string | null;
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  merchant_type?: string | null;
  store_raw?: string | null;
  store_normalized?: string | null;
  total: number | string;
  tax: number | string;
  tax_is_known?: boolean | number | null;
  currency?: string | null;
  analysis_json: string;
  recognition_snapshot_json?: string | null;
  user_items_json?: string | null;
  user_edited?: boolean | number | null;
  final_total?: number | string | null;
  final_category?: string | null;
  note?: string | null;
  ocr_request_id?: string | null;
  client_updated_at?: string | null;
  deleted_at?: string | null;
};

export type LocalRestoredReceiptInsert = {
  id: string;
  created_at: number;
  transaction_at: number | null;
  scanned_at: number | null;
  image_uri: string;
  source: string | null;
  merchant_raw: string | null;
  merchant_normalized: string | null;
  merchant_type: string | null;
  store_raw: string | null;
  store_normalized: string | null;
  total: number;
  tax: number;
  tax_is_known: number;
  currency: string;
  analysis_json: string;
  recognition_snapshot_json: string | null;
  user_edited: number;
  final_total: number | null;
  final_category: string | null;
  note: string | null;
  user_items_json: string | null;
  user_id: string;
  installation_id: string | null;
  transaction_source: string;
  ocr_request_id: string | null;
  client_updated_at: number;
};

function isoToMs(iso: string | null | undefined): number | null {
  if (iso == null || typeof iso !== 'string' || !iso.trim()) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function asBool01(v: boolean | number | null | undefined): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number(v) === 1 ? 1 : 0;
}

function asFiniteNumber(v: number | string | null | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asFiniteNumberOrNull(
  v: number | string | null | undefined
): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map one active cloud receipt to local insert values.
 *
 * installation_id: prefer CURRENT installation (row is now present on this device).
 * Does not rewrite cloud.
 *
 * image_uri: '' — original images are not cloud-backed in P0; History/Detail tolerate empty.
 */
export function mapCloudReceiptToLocalInsert(
  cloud: CloudUserReceiptRow,
  params: {
    expectedUserId: string;
    currentInstallationId: string;
    fallbackClientUpdatedAtMs?: number;
  }
): LocalRestoredReceiptInsert {
  const expected = params.expectedUserId.trim();
  const userId = typeof cloud.user_id === 'string' ? cloud.user_id.trim() : '';
  if (!expected || !userId || userId !== expected) {
    throw new Error('Cloud receipt user_id does not match verified restore user');
  }
  if (cloud.deleted_at != null && String(cloud.deleted_at).trim() !== '') {
    throw new Error('Cannot restore tombstoned cloud receipt');
  }
  if (typeof cloud.id !== 'string' || !cloud.id.trim()) {
    throw new Error('Cloud receipt missing id');
  }
  if (typeof cloud.analysis_json !== 'string' || !cloud.analysis_json.trim()) {
    throw new Error('Cloud receipt missing analysis_json');
  }

  const createdAt =
    isoToMs(cloud.created_at) ?? params.fallbackClientUpdatedAtMs ?? Date.now();
  const clientUpdatedAt =
    isoToMs(cloud.client_updated_at ?? null) ??
    params.fallbackClientUpdatedAtMs ??
    createdAt;

  return {
    id: cloud.id.trim(),
    created_at: createdAt,
    transaction_at: isoToMs(cloud.transaction_at ?? null),
    scanned_at: isoToMs(cloud.scanned_at ?? null),
    image_uri: '',
    source:
      typeof cloud.social_source === 'string' && cloud.social_source.trim()
        ? cloud.social_source.trim()
        : null,
    merchant_raw: cloud.merchant_raw ?? null,
    merchant_normalized: cloud.merchant_normalized ?? null,
    merchant_type: cloud.merchant_type ?? null,
    store_raw: cloud.store_raw ?? null,
    store_normalized: cloud.store_normalized ?? null,
    total: asFiniteNumber(cloud.total, 0),
    tax: asFiniteNumber(cloud.tax, 0),
    tax_is_known: asBool01(cloud.tax_is_known),
    currency:
      typeof cloud.currency === 'string' && cloud.currency.trim()
        ? cloud.currency.trim()
        : 'JPY',
    // TEXT evidence — exact cloud string, never re-serialized.
    analysis_json: cloud.analysis_json,
    recognition_snapshot_json:
      typeof cloud.recognition_snapshot_json === 'string'
        ? cloud.recognition_snapshot_json
        : null,
    user_edited: asBool01(cloud.user_edited),
    final_total: asFiniteNumberOrNull(cloud.final_total),
    final_category:
      typeof cloud.final_category === 'string' && cloud.final_category.trim()
        ? cloud.final_category.trim()
        : null,
    note:
      typeof cloud.note === 'string' && cloud.note.trim()
        ? cloud.note.trim()
        : null,
    user_items_json:
      typeof cloud.user_items_json === 'string' ? cloud.user_items_json : null,
    user_id: userId,
    installation_id:
      typeof params.currentInstallationId === 'string' &&
      params.currentInstallationId.trim()
        ? params.currentInstallationId.trim()
        : null,
    transaction_source:
      typeof cloud.transaction_source === 'string' && cloud.transaction_source.trim()
        ? cloud.transaction_source.trim()
        : 'receipt_ocr',
    ocr_request_id:
      typeof cloud.ocr_request_id === 'string' && cloud.ocr_request_id.trim()
        ? cloud.ocr_request_id.trim()
        : null,
    client_updated_at: clientUpdatedAt,
  };
}
