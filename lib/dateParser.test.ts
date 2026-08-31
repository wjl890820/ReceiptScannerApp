import {
  normalizeReceiptDateTime,
  parseReceiptDateTime,
} from './dateParser';

/** Fixed clock: 2026-08-11 12:00 Asia/Tokyo — avoids Date.now() in assertions. */
const NOW_MS = new Date('2026-08-11T12:00:00+09:00').getTime();

function expectLocalParts(
  ts: number,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  expect(get('year')).toBe(year);
  expect(get('month')).toBe(month);
  expect(get('day')).toBe(day);
  expect(get('hour')).toBe(hour);
  expect(get('minute')).toBe(minute);
  expect(get('second')).toBe(second);
}

describe('receipt datetime parsing', () => {
  it('parses Japanese weekday format', () => {
    const ts = parseReceiptDateTime('2025年12月20日(土) 19:09', {
      nowMs: NOW_MS,
    });
    expect(ts).not.toBeNull();
    expectLocalParts(ts!, 2025, 12, 20, 19, 9);
  });

  it('parses YYYY/MM/DD(曜) HH:mm', () => {
    const ts = parseReceiptDateTime('2025/12/20(土) 18:17', {
      nowMs: NOW_MS,
    });
    expect(ts).not.toBeNull();
    expectLocalParts(ts!, 2025, 12, 20, 18, 17);
  });

  it('parses MM/DD/YYYY HH:mm:ss (Costco unambiguous day>12)', () => {
    const ts = parseReceiptDateTime('01/16/2026 18:49:34', {
      nowMs: NOW_MS,
    });
    expect(ts).not.toBeNull();
    expectLocalParts(ts!, 2026, 1, 16, 18, 49, 34);
  });

  it('parses MM/DD/YYYY HH:mm:ss for early January when Costco merchant', () => {
    const ts = parseReceiptDateTime('01/04/2026 15:31:31', {
      nowMs: NOW_MS,
      merchant: 'コストコ',
    });
    expect(ts).not.toBeNull();
    expectLocalParts(ts!, 2026, 1, 4, 15, 31, 31);
  });

  it('Sample 077: Costco ambiguous 06/10/2026 → 2026-06-10', () => {
    expect(
      normalizeReceiptDateTime('06/10/2026 10:50:58', { allowAmbiguousMdy: true })
    ).toBe('2026-06-10 10:50:58');
    const ts = parseReceiptDateTime('06/10/2026 10:50:58', {
      nowMs: NOW_MS,
      merchant: 'コストコ',
    });
    expect(ts).not.toBeNull();
    expectLocalParts(ts!, 2026, 6, 10, 10, 50, 58);

    const tsEn = parseReceiptDateTime('06/10/2026 10:50:58', {
      nowMs: NOW_MS,
      merchant: 'Costco Wholesale',
    });
    expect(tsEn).not.toBeNull();
    expectLocalParts(tsEn!, 2026, 6, 10, 10, 50, 58);
  });

  it('Sample 081: Costco ambiguous 07/06/2023 → 2023-07-06 (MDY)', () => {
    expect(
      normalizeReceiptDateTime('07/06/2023 11:44:46', { allowAmbiguousMdy: true })
    ).toBe('2023-07-06 11:44:46');
    const ts = parseReceiptDateTime('07/06/2023 11:44:46', {
      nowMs: NOW_MS,
      merchant: 'コストコ',
    });
    expect(ts).not.toBeNull();
    expectLocalParts(ts!, 2023, 7, 6, 11, 44, 46);
  });

  it('unknown merchant + ambiguous 06/10/2026 does not assume MDY', () => {
    expect(normalizeReceiptDateTime('06/10/2026 10:50:58')).toBe('');
    expect(
      parseReceiptDateTime('06/10/2026 10:50:58', { nowMs: NOW_MS, merchant: 'イオン' })
    ).toBeNull();
  });

  it('unknown merchant + ambiguous 07/06/2023 does not assume MDY', () => {
    expect(normalizeReceiptDateTime('07/06/2023 11:44:46')).toBe('');
    expect(
      parseReceiptDateTime('07/06/2023 11:44:46', { nowMs: NOW_MS })
    ).toBeNull();
  });

  it('does not fall back to current/scan time on invalid or empty input', () => {
    const before = NOW_MS;
    expect(
      parseReceiptDateTime('', { nowMs: NOW_MS })
    ).toBeNull();
    expect(
      parseReceiptDateTime('not-a-date', { nowMs: NOW_MS })
    ).toBeNull();
    expect(
      parseReceiptDateTime(null, { nowMs: NOW_MS })
    ).toBeNull();
    // Must not invent "now"
    expect(
      parseReceiptDateTime('garbage', { fallbackToNow: false, nowMs: NOW_MS })
    ).not.toBe(before);
  });

  it('normalize keeps slash dates after stripping weekday', () => {
    expect(normalizeReceiptDateTime('2025/12/20(土) 18:17')).toBe(
      '2025-12-20 18:17'
    );
    expect(normalizeReceiptDateTime('01/16/2026 18:49:34')).toBe(
      '2026-01-16 18:49:34'
    );
  });

  describe('Sample 029 OCR spacing + weekday annotation', () => {
    const cases = [
      '2026/ 2/21(土) 12:28',
      '2026/2/21（土）12:28',
      '2026 / 2 / 21 12:28',
      '2026年2月21日(土) 12:28',
      '2026年2月21日（土）12:28',
      '2026/2/21 12:28', // canonical control
    ];

    it.each(cases)('parses %s → 2026-02-21 12:28 Asia/Tokyo', (raw) => {
      expect(normalizeReceiptDateTime(raw)).toBe('2026-02-21 12:28');
      const ts = parseReceiptDateTime(raw, { nowMs: NOW_MS });
      expect(ts).not.toBeNull();
      expectLocalParts(ts!, 2026, 2, 21, 12, 28);
    });
  });

  it('accepts only strict machine ISO with timezone after deterministic formats', () => {
    const ts = parseReceiptDateTime('2026-01-16T18:49:34+09:00', {
      nowMs: NOW_MS,
    });
    expect(ts).not.toBeNull();
    expectLocalParts(ts!, 2026, 1, 16, 18, 49, 34);

    // timezone-less datetime must not rely on JS Date guessing
    expect(
      parseReceiptDateTime('2026-01-16T18:49:34', { nowMs: NOW_MS })
    ).toBeNull();
  });

  describe('DATE TEST MATRIX', () => {
    it('Costco 06/10/2026 10:50:58 → 2026-06-10', () => {
      const ts = parseReceiptDateTime('06/10/2026 10:50:58', {
        nowMs: NOW_MS,
        merchant: 'コストコ',
      });
      expect(ts).not.toBeNull();
      expectLocalParts(ts!, 2026, 6, 10, 10, 50, 58);
    });

    it('Costco 07/06/2023 11:44:46 → 2023-07-06', () => {
      const ts = parseReceiptDateTime('07/06/2023 11:44:46', {
        nowMs: NOW_MS,
        merchant: 'コストコ',
      });
      expect(ts).not.toBeNull();
      expectLocalParts(ts!, 2023, 7, 6, 11, 44, 46);

      const tsEn = parseReceiptDateTime('07/06/2023 11:44:46', {
        nowMs: NOW_MS,
        merchant: 'Costco',
      });
      expect(tsEn).not.toBeNull();
      expectLocalParts(tsEn!, 2023, 7, 6, 11, 44, 46);
    });

    it('unknown merchant 06/10/2026 remains ambiguous', () => {
      expect(parseReceiptDateTime('06/10/2026', { nowMs: NOW_MS })).toBeNull();
      expect(
        parseReceiptDateTime('06/10/2026 10:50:58', { nowMs: NOW_MS, merchant: 'イオン' })
      ).toBeNull();
    });

    it('unknown merchant 07/06/2023 remains ambiguous', () => {
      expect(parseReceiptDateTime('07/06/2023', { nowMs: NOW_MS })).toBeNull();
      expect(parseReceiptDateTime('07/06/2023 11:44:46', { nowMs: NOW_MS })).toBeNull();
    });

    it('unambiguous 01/16/2026 is valid without Costco', () => {
      const ts = parseReceiptDateTime('01/16/2026', { nowMs: NOW_MS });
      expect(ts).not.toBeNull();
      expect(normalizeReceiptDateTime('01/16/2026')).toBe('2026-01-16 00:00');
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(ts!));
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      expect(get('year')).toBe(2026);
      expect(get('month')).toBe(1);
      expect(get('day')).toBe(16);
    });

    it('AEON 2026/ 2/21(土) 12:28 still PASS', () => {
      const ts = parseReceiptDateTime('2026/ 2/21(土) 12:28', { nowMs: NOW_MS });
      expect(ts).not.toBeNull();
      expectLocalParts(ts!, 2026, 2, 21, 12, 28);
    });
  });

  it('never feeds raw receipt strings to new Date in parser or save path', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const parserSource = fs.readFileSync(
      path.resolve(__dirname, 'dateParser.ts'),
      'utf8'
    );
    const dbSource = fs.readFileSync(path.resolve(__dirname, 'db.ts'), 'utf8');
    const projectionSource = fs.readFileSync(
      path.resolve(__dirname, 'receiptSaveProjection.ts'),
      'utf8'
    );

    expect(parserSource).not.toMatch(
      /new Date\(\s*(trimmed|workStr|dateTimeStr|input)\s*\)/
    );
    // Date only allowed on constructed Tokyo ISO (`iso`) or verified machine ISO (`value`).
    expect(parserSource).toMatch(/new Date\(iso\)/);
    expect(parserSource).toMatch(/new Date\(value\)/);

    expect(dbSource).toContain('projectReceiptSaveMaterialEvidence');
    expect(projectionSource).toContain('parseReceiptDateTime(transactionDateText');
    expect(projectionSource).toContain('fallbackToNow: false');
    expect(dbSource).not.toMatch(/new Date\(\s*txDateStr/);
    expect(dbSource).not.toMatch(/new Date\(\s*txDate/);
  });
});
