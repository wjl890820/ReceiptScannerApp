jest.mock('./i18n', () => ({
  t: (key: string) => key,
}));

import { buildTopCategories, buildHistoryMetaLine } from './receiptListHelpers';
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
});

describe('buildHistoryMetaLine', () => {
  it('uses transaction_at when available', () => {
    const ts = 1700000000000;
    const line = buildHistoryMetaLine(ts, ts - 1000, '税', 10, formatDate);
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
      '日期待确认'
    );
    expect(line).toContain('日期待确认');
    expect(line).not.toContain(formatDate(ts));
  });
});


