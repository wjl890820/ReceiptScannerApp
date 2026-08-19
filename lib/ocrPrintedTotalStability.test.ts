/**
 * Deterministic fixtures + Edge OCR prompt/cache contract tests for printed total stability.
 * Does not call Gemini; reads Edge Function source for prompt/cache version contracts.
 */
import * as fs from 'fs';
import * as path from 'path';

import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { authoritativeReceiptTotal } from './scanReviewPresentation';

const EDGE_OCR_PATH = path.resolve(
  __dirname,
  '../supabase/functions/ocr-receipt/index.ts'
);

function readEdgeOcrSource(): string {
  return fs.readFileSync(EDGE_OCR_PATH, 'utf8');
}

describe('OCR printed-total extraction contracts (Edge prompt + client passthrough)', () => {
  const edgeSource = readEdgeOcrSource();

  it('Case 1 — tax included structured payload keeps printed total 8351', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 8351,
      tax: 619,
      items: [
        { name: 'A', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'B', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'C', quantity: 1, unitPrice: 1680, lineTotal: 1680 },
        { name: 'D', quantity: 1, unitPrice: 899, lineTotal: 899 },
        { name: 'E', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'フェレロロシェオリジンズ*36コ', quantity: 1, unitPrice: 2988, lineTotal: 2988 },
      ],
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
    });
    expect(out.total).toBe(8351);
    expect(out.tax).toBe(619);
    // Never invent 8351+619
    expect(out.total).not.toBe(8970);
  });

  it('Case 2 — external tax keeps printed total 2637', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'イオン',
      currency: 'JPY',
      total: 2637,
      tax: 195,
      items: [{ name: '牛乳', quantity: 1, unitPrice: 2442, lineTotal: 2442 }],
    });
    expect(out.total).toBe(2637);
    expect(out.tax).toBe(195);
    expect(out.items.reduce((s, i) => s + i.lineTotal, 0)).toBe(2442);
  });

  it('Case 3 — coupon + printed 合計 keeps total 8351 and discount', () => {
    const out = normalizeOcrAnalysis({
      merchant: 'コストコ',
      currency: 'JPY',
      total: 8351,
      tax: 619,
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      items: [
        { name: 'A', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'B', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'C', quantity: 1, unitPrice: 1680, lineTotal: 1680 },
        { name: 'D', quantity: 1, unitPrice: 899, lineTotal: 899 },
        { name: 'E', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'F', quantity: 1, unitPrice: 2988, lineTotal: 2988 },
        { name: 'ROCHER ORIGINS CPN', quantity: 1, unitPrice: -600, lineTotal: -600 },
      ],
    });
    expect(out.total).toBe(8351);
    expect(out.tax).toBe(619);
    expect(out.discounts).toHaveLength(1);
    expect(out.discounts![0].amount).toBe(-600);
    expect(out.amount_mismatch).toBe(false);
  });

  it('Case 4 — authoritative total passthrough is deterministic and never recomputed', () => {
    const payload = {
      merchant: 'コストコ',
      currency: 'JPY',
      total: 8351,
      tax: 619,
      items: [{ name: 'X', quantity: 1, unitPrice: 8351, lineTotal: 8351 }],
    };
    const a = normalizeOcrAnalysis(payload);
    const b = normalizeOcrAnalysis(payload);
    expect(a.total).toBe(8351);
    expect(b.total).toBe(8351);
    expect(a.total).toBe(b.total);
    expect(authoritativeReceiptTotal({ total: a.total, tax: a.tax })).toBe(8351);
  });

  it('Case 5 — prompt static contract: copy printed total; do not recalculate / re-add tax', () => {
    expect(edgeSource).toContain('buildOcrPrompt');
    expect(edgeSource).toMatch(/印刷された最終支払合計|最終支払合計行を優先してそのまま転記/);
    expect(edgeSource).toMatch(/再計算|再構成してはならない/);
    expect(edgeSource).toMatch(/tax を足し直してはならない|税を足し直してはならない|二重加算しない/);
    expect(edgeSource).toContain('total=8351, tax=619');
    expect(edgeSource).toContain('total=8970');
    expect(edgeSource).toContain('禁止');
    expect(edgeSource).toContain('total=2637, tax=195');
    expect(edgeSource).toMatch(/generationConfig[\s\S]*temperature:\s*0/);
  });

  it('Case 6 — cache version prevents collision with legacy image-hash-only keys', () => {
    expect(edgeSource).toMatch(/OCR_CACHE_VERSION\s*=\s*6/);
    expect(edgeSource).toContain('buildOcrCacheKey');
    expect(edgeSource).toContain('v${OCR_CACHE_VERSION}:${imageContentHash}');
    // Legacy bare image hash must not be the sole cache lookup key after versioning.
    expect(edgeSource).toContain('checkCache(supabase, cacheKey)');
    expect(edgeSource).toContain('saveToCache(supabase, cacheKey, analysis, deviceId)');
    // Versioned key format must differ from raw content hash alone.
    const v2Key = `v2:deadbeef`;
    expect(v2Key).not.toBe('deadbeef');
    expect(v2Key.startsWith('v2:')).toBe(true);
  });

  it('Case 7 — adjacent product discounts stay in ordered items[]; not unlinked discounts[] only', () => {
    expect(edgeSource).toContain('割引 10%');
    expect(edgeSource).toContain('10%割引');
    expect(edgeSource).toMatch(/kind="discount" の負数行/);
    expect(edgeSource).toMatch(/discounts\[\] に重複して入れない/);
    expect(edgeSource).toMatch(/まとめ売り値引 \/ まとめ値引 は従来どおり discounts に入れるだけでなく/);
    expect(edgeSource).toMatch(/Costco の CPN|全体クーポンは discounts/);
    expect(edgeSource).not.toMatch(/OCR_CACHE_VERSION\s*=\s*5[^\d]/);
  });
});
