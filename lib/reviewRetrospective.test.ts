(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('./db', () => ({
  listReceiptsForReviewStats: jest.fn(),
  listManualProductNameAliases: jest.fn(),
  countManualProductDictionaryEntries: jest.fn(),
}));

jest.mock('./i18n', () => ({
  getCurrentLocale: () => 'zh',
}));

import { diffReceiptSnapshotVsFinal, nameCorrectionMatchesManualAlias } from './reviewRetrospective';

type Row = {
  id: string;
  created_at: number;
  analysis_json: string;
  recognition_snapshot_json: string;
};

function row(snap: unknown, fin: unknown): Row {
  return {
    id: 't1',
    created_at: 1,
    analysis_json: JSON.stringify(fin),
    recognition_snapshot_json: JSON.stringify(snap),
  };
}

describe('diffReceiptSnapshotVsFinal', () => {
  it('detects fully unchanged', () => {
    const body = {
      merchant: 'A',
      transactionDate: '2024-01-02',
      total: 100,
      tax: 8,
      items: [{ name: 'x', category: 'other_grocery', quantity: 1, lineTotal: 100 }],
    };
    const d = diffReceiptSnapshotVsFinal(row(body, { ...body, review_meta: { error_tags: [] } }));
    expect(d?.fullyUnchanged).toBe(true);
    expect(d?.corrected).toBe(false);
  });

  it('detects category-only receipt', () => {
    const snap = {
      merchant: 'A',
      transactionDate: '2024-01-02',
      total: 100,
      tax: 8,
      items: [{ name: 'x', category: 'other_grocery', quantity: 1, lineTotal: 100 }],
    };
    const fin = {
      ...snap,
      items: [{ name: 'x', category: 'produce', quantity: 1, lineTotal: 100 }],
      review_meta: { error_tags: ['CATEGORY_ERROR'] },
    };
    const d = diffReceiptSnapshotVsFinal(row(snap, fin));
    expect(d?.categoryOnlyReceipt).toBe(true);
    expect(d?.hasItemNameDiff).toBe(false);
  });

  it('detects header date only', () => {
    const snap = {
      merchant: 'A',
      transactionDate: '2024-01-01',
      total: 100,
      tax: 8,
      items: [{ name: 'x', category: 'produce', quantity: 1, lineTotal: 100 }],
    };
    const fin = {
      ...snap,
      transactionDate: '2024-01-02',
      review_meta: { error_tags: ['DATE_ERROR'] },
    };
    const d = diffReceiptSnapshotVsFinal(row(snap, fin));
    expect(d?.headerNumericOrDateOnlyReceipt).toBe(true);
  });

  it('detects item name change', () => {
    const snap = {
      merchant: 'A',
      total: 100,
      tax: 0,
      items: [{ name: 'old', category: 'produce', quantity: 1, lineTotal: 100 }],
    };
    const fin = {
      ...snap,
      items: [{ name: 'new', category: 'produce', quantity: 1, lineTotal: 100 }],
    };
    const d = diffReceiptSnapshotVsFinal(row(snap, fin));
    expect(d?.hasItemNameDiff).toBe(true);
    expect(d?.categoryOnlyReceipt).toBe(false);
  });
});

describe('nameCorrectionMatchesManualAlias', () => {
  it('matches empty merchant hint row', () => {
    const set = new Set<string>(['norm\tcan\t']);
    expect(nameCorrectionMatchesManualAlias(set, 'norm', 'Can', null)).toBe(true);
  });
});
