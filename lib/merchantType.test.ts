import {
  detectMerchantType,
  detectMerchantTypeFromReceipt,
  resolveReceiptMerchantType,
  isV1SupportedMerchantType,
  isV1SupportedReceipt,
  filterV1SupportedReceipts,
} from './merchantType';
import { detectCostcoReceiptSignals } from './groceryDetector';
import { classifyItemByName } from './productCategory';
import { normalizeReceiptDateTime, parseReceiptDateTime } from './dateParser';

describe('detectMerchantType', () => {
  it('York Benimaru → supermarket', () => {
    expect(detectMerchantType('ヨークベニマル', null)).toBe('supermarket');
  });

  it('AEON → supermarket', () => {
    expect(detectMerchantType('イオン', null)).toBe('supermarket');
  });

  it('FamilyMart → convenience', () => {
    expect(detectMerchantType('ファミリーマート', null)).toBe('convenience');
  });

  it('7-Eleven → convenience', () => {
    expect(detectMerchantType('セブン-イレブン', null)).toBe('convenience');
  });

  it('Lawson → convenience', () => {
    expect(detectMerchantType('ローソン', null)).toBe('convenience');
  });

  it('unknown string → unknown', () => {
    expect(detectMerchantType('なぞのお店xyz', null)).toBe('unknown');
  });

  it('药妆 → other', () => {
    expect(detectMerchantType('マツキヨ', null)).toBe('other');
  });
});

describe('resolveReceiptMerchantType', () => {
  it('DB 有 merchant_type 时直接使用', () => {
    expect(
      resolveReceiptMerchantType({
        merchant_type: 'convenience',
        merchant_raw: 'イオン',
      })
    ).toBe('convenience');
  });

  it('merchant_type 为 null 时 runtime fallback', () => {
    expect(
      resolveReceiptMerchantType({
        merchant_type: null,
        merchant_raw: 'セブン-イレブン',
      })
    ).toBe('convenience');
  });
});

describe('merchant_type 不改变商品 category', () => {
  it('convenience 商户下 シュガーバター 仍为 snacks_drinks（非 ready_to_eat）', () => {
    expect(detectMerchantType('セブン-イレブン', null)).toBe('convenience');
    expect(classifyItemByName('シュガーバター')).toBe('snacks_drinks');
  });
});

describe('isV1SupportedMerchantType', () => {
  it('supermarket → true', () => {
    expect(isV1SupportedMerchantType('supermarket')).toBe(true);
  });

  it('convenience → true', () => {
    expect(isV1SupportedMerchantType('convenience')).toBe(true);
  });

  it('other → false', () => {
    expect(isV1SupportedMerchantType('other')).toBe(false);
  });

  it('unknown → false', () => {
    expect(isV1SupportedMerchantType('unknown')).toBe(false);
  });
});

describe('isV1SupportedReceipt', () => {
  it('DB merchant_type=convenience → supported', () => {
    expect(
      isV1SupportedReceipt({
        merchant_type: 'convenience',
        merchant_raw: 'イオン',
        analysis_json: '{}',
      })
    ).toBe(true);
  });

  it('runtime fallback：FamilyMart → supported', () => {
    expect(
      isV1SupportedReceipt({
        merchant_type: null,
        merchant_raw: 'ファミリーマート',
        analysis_json: '{}',
      })
    ).toBe(true);
  });

  it('other merchant → not supported', () => {
    expect(
      isV1SupportedReceipt({
        merchant_type: 'other',
        merchant_raw: 'マツキヨ',
        analysis_json: '{}',
      })
    ).toBe(false);
  });

  it('legacy analysis_json is_grocery=true → supported', () => {
    expect(
      isV1SupportedReceipt({
        merchant_type: null,
        merchant_raw: 'なぞのお店',
        analysis_json: JSON.stringify({ is_grocery: true }),
      })
    ).toBe(true);
  });

  it('filterV1SupportedReceipts 只保留 supported', () => {
    const receipts = [
      { merchant_type: 'supermarket' as const, merchant_raw: 'ヨーク', analysis_json: '{}' },
      { merchant_type: 'convenience' as const, merchant_raw: 'ローソン', analysis_json: '{}' },
      { merchant_type: 'other' as const, merchant_raw: 'マツキヨ', analysis_json: '{}' },
    ];
    expect(filterV1SupportedReceipts(receipts)).toHaveLength(2);
  });
});

describe('Costco cropped-header signals', () => {
  it('does not treat BIZ/GOLD alone as Costco', () => {
    expect(detectCostcoReceiptSignals({ merchant: 'BIZ/GOLD', items: [] }).isCostco).toBe(false);
    expect(detectMerchantType('BIZ/GOLD', null)).toBe('unknown');
  });

  it('promotes cropped-header Costco with multiple strong signals', () => {
    const items = [
      { name: '123456 KIRKLAND WATER E' },
      { name: '234567 BANANA E' },
      { name: '345678 CHICKEN T' },
      { name: '御買上げ点数 3' },
    ];
    const hit = detectCostcoReceiptSignals({ merchant: 'BIZ/GOLD', items });
    expect(hit.isCostco).toBe(true);
    expect(
      detectMerchantTypeFromReceipt({ merchant: 'BIZ/GOLD', items })
    ).toBe('supermarket');
  });

  it('explicit Costco name remains supermarket', () => {
    expect(detectMerchantType('コストコ', null)).toBe('supermarket');
  });
});

describe('Sample 044 MM/DD/YYYY date fixture', () => {
  const NOW_MS = new Date('2026-08-11T12:00:00+09:00').getTime();
  it('12/27/2025 10:32 → 2025-12-27 10:32 Asia/Tokyo (parser OK; OCR misread is upstream)', () => {
    expect(normalizeReceiptDateTime('12/27/2025 10:32')).toBe('2025-12-27 10:32');
    const ts = parseReceiptDateTime('12/27/2025 10:32', { nowMs: NOW_MS });
    expect(ts).not.toBeNull();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts!));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    expect(get('year')).toBe(2025);
    expect(get('month')).toBe(12);
    expect(get('day')).toBe(27);
    expect(get('hour')).toBe(10);
    expect(get('minute')).toBe(32);
  });
});
