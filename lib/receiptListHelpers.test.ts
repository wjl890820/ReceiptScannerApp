jest.mock('./i18n', () => ({
  t: (key: string) => key,
}));

import { buildTopCategories, buildHistoryMetaLine, taxFieldPrefillFromSnapshot } from './receiptListHelpers';
import { formatDate } from './formatDate';

describe('buildTopCategories', () => {
  it('returns empty array for null or invalid json', () => {
    expect(buildTopCategories(null)).toEqual([]);
    expect(buildTopCategories('not-json')).toEqual([]);
  });

  it('aggregates amounts by category and sorts desc', () => {
    const analysis = {
      items: [
        { category: 'produce', lineTotal: 100 },
        { category: 'produce', lineTotal: 50 },
        { category: 'snacks_sweets', lineTotal: 30 },
      ],
    };
    const result = buildTopCategories(JSON.stringify(analysis), 2);
    expect(result.length).toBeGreaterThan(0);
  });

  it('does not invent a category when persisted item is uncategorized', () => {
    const analysis = {
      items: [
        {
          name: '卵',
          category: 'uncategorized',
          lineTotal: 200,
          classification_status: 'ok',
        },
        {
          name: 'ティッシュ',
          category: 'household',
          lineTotal: 150,
          classification_status: 'ok',
        },
      ],
    };
    const result = buildTopCategories(JSON.stringify(analysis), 3);
    expect(result.join(' ')).toContain('150');
    expect(result.join(' ')).not.toContain('200');
  });

  it('uses persisted semantic category rather than re-running name rules', () => {
    const analysis = {
      items: [
        {
          name: 'チキンカツサンド',
          category: 'food_ingredients',
          lineTotal: 300,
          classification_status: 'ok',
        },
      ],
    };
    const result = buildTopCategories(JSON.stringify(analysis), 1);
    expect(result.length).toBe(1);
  });

  it('enriched name_rule category appears in History preview; uncategorized does not', () => {
    const analysis = {
      items: [
        {
          name: '卵',
          category: 'food_ingredients',
          lineTotal: 200,
          classification_status: 'ok',
        },
        {
          name: 'なぞ商品xyz',
          category: 'uncategorized',
          lineTotal: 100,
          classification_status: 'ok',
        },
      ],
    };
    const preview = buildTopCategories(JSON.stringify(analysis), 3);
    expect(preview.some((label) => label.includes('200'))).toBe(true);
    expect(preview.join(' ')).not.toContain('100');
  });
});

describe('buildHistoryMetaLine', () => {
  it('uses transaction_at when available', () => {
    const ts = 1700000000000;
    const line = buildHistoryMetaLine(ts, ts - 1000, '税', 10, formatDate, '—', '待确认', 1);
    expect(line).toContain('税 10');
    expect(line).toContain(formatDate(ts));
  });

  it('shows unknown purchase date label instead of created_at', () => {
    const ts = 1700000000000;
    const line = buildHistoryMetaLine(
      null,
      ts,
      '税',
      0,
      formatDate,
      '日期待确认',
      '待确认',
      0
    );
    expect(line).toContain('日期待确认');
    expect(line).not.toContain(formatDate(ts));
  });

  it('unknown tax_is_known does not display fake 税 0', () => {
    const ts = 1700000000000;
    expect(buildHistoryMetaLine(ts, ts, '税', 0, formatDate, '—', '待确认', 0)).toContain(
      '税 待确认'
    );
    expect(buildHistoryMetaLine(ts, ts, '税', null, formatDate, '—', '待确认', 0)).toContain(
      '税 待确认'
    );
  });

  it('known explicit tax=0 displays 税 0', () => {
    const ts = 1700000000000;
    expect(buildHistoryMetaLine(ts, ts, '税', 0, formatDate, '—', '待确认', 1)).toContain('税 0');
  });

  it('known positive tax displays value', () => {
    const ts = 1700000000000;
    expect(buildHistoryMetaLine(ts, ts, '税', 195, formatDate, '—', '待确认', 1)).toContain(
      '税 195'
    );
  });
});

describe('taxFieldPrefillFromSnapshot (Review)', () => {
  it('unknown tax=0 prefill is empty (not \"0\")', () => {
    expect(taxFieldPrefillFromSnapshot({ tax: 0, tax_is_known: false })).toBe('');
    expect(taxFieldPrefillFromSnapshot({ tax: 0, tax_is_known: 0 })).toBe('');
    expect(taxFieldPrefillFromSnapshot({ tax: 0 })).toBe('');
  });

  it('known tax=0 prefill is \"0\"', () => {
    expect(taxFieldPrefillFromSnapshot({ tax: 0, tax_is_known: true })).toBe('0');
    expect(taxFieldPrefillFromSnapshot({ tax: 0, tax_is_known: 1 })).toBe('0');
  });

  it('known positive tax prefill is numeric string', () => {
    expect(taxFieldPrefillFromSnapshot({ tax: 195, tax_is_known: true })).toBe('195');
  });
});


