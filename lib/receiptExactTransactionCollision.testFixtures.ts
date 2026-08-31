import type { ReceiptRow } from './db';

export const YORK_COLLISION_TRANSACTION_AT = 1_782_791_700_000;

export const YORK_COLLISION_BASKET = [
  [1, 429],
  [1, 429],
  [1, 138],
  [1, 95],
  [1, 27],
  [1, 386],
  [1, 343],
  [1, 192],
  [1, 181],
  [1, 181],
  [1, 116],
  [1, 192],
  [1, 138],
  [1, 278],
  [1, 343],
  [1, 181],
  [1, 51],
  [1, 170],
  [2, 232],
] as const;

const NAMES_A = [
  '青木1食うどん',
  '牛乳',
  'りんご',
  '納豆',
  'もやし',
  '7 ジャージャー麺',
  '7 フルーツオレ大',
  '7 チョコシュー',
  '熟成あこね食パン',
  'グレープチョコパニ',
  'ふぞろい小箱包',
  '豆腐',
  'ヨーグルト',
  'たまご',
  'バナナ',
  'チーズ',
  'ねぎ',
  'パン',
  '飲料',
];

const NAMES_C = [
  '青木1食うどん',
  '牛乳',
  'りんご',
  '納豆',
  'もやし',
  'ジャージャー麺',
  'フルーツオレ大',
  'チョコシュー',
  '熟成易こね食パン',
  'クレープチョコバニ',
  'ふぞろい小籠包',
  '豆腐',
  'ヨーグルト',
  'たまご',
  'バナナ',
  'チーズ',
  'ねぎ',
  'パン',
  '飲料',
];

function makeYorkReceipt(input: {
  id: string;
  merchant: string;
  names: readonly string[];
  createdAt: number;
}): ReceiptRow {
  const items = YORK_COLLISION_BASKET.map(([quantity, lineTotal], index) => ({
    name: input.names[index] ?? `商品${index + 1}`,
    quantity,
    lineTotal,
  }));
  return {
    id: input.id,
    created_at: input.createdAt,
    transaction_at: YORK_COLLISION_TRANSACTION_AT,
    image_uri: `file://${input.id}.jpg`,
    merchant_raw: input.merchant,
    merchant_normalized: input.merchant,
    merchant_type: 'supermarket',
    total: 4102,
    tax: 303,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      merchant: input.merchant,
      transactionDate: '2026-06-30 12:55',
      total: 4102,
      tax: 303,
      tax_is_known: true,
      currency: 'JPY',
      items,
      discounts: [],
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    recognition_snapshot_json: null,
    user_edited: 1,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    transaction_source: 'receipt_ocr',
  };
}

export function makeYorkCollisionReceiptA(): ReceiptRow {
  return makeYorkReceipt({
    id: 'Z7PvgLEzfhNia5e4Vnmwl',
    merchant: 'ヨークベニマル',
    names: NAMES_A,
    createdAt: YORK_COLLISION_TRANSACTION_AT + 1_000,
  });
}

export function makeYorkCollisionReceiptB(): ReceiptRow {
  return makeYorkReceipt({
    id: 'zOC3S5ORqG4ZIGsE4er4Y',
    merchant: 'ヨークベニマル 古川南店',
    names: NAMES_C,
    createdAt: YORK_COLLISION_TRANSACTION_AT + 2_000,
  });
}

export function makeYorkCollisionReceiptC(): ReceiptRow {
  return makeYorkReceipt({
    id: 'qBOipZtq5RkyZC8KXVRkf',
    merchant: 'ヨークベニマル古川南店',
    names: NAMES_C,
    createdAt: YORK_COLLISION_TRANSACTION_AT + 3_000,
  });
}

export function cloneCollisionReceipt(
  receipt: ReceiptRow,
  patch: Partial<ReceiptRow> & {
    analysisPatch?: Record<string, unknown>;
    items?: unknown[];
  }
): ReceiptRow {
  const analysis = JSON.parse(receipt.analysis_json) as Record<string, unknown>;
  const { analysisPatch, items, ...rowPatch } = patch;
  return {
    ...receipt,
    ...rowPatch,
    analysis_json: JSON.stringify({
      ...analysis,
      ...analysisPatch,
      ...(items ? { items } : {}),
    }),
  };
}

export function collisionItems(receipt: ReceiptRow): Record<string, unknown>[] {
  return (JSON.parse(receipt.analysis_json) as { items: Record<string, unknown>[] })
    .items;
}

