/**
 * B3 transactionDate verification — deterministic trigger/acceptance tests.
 */
import {
  acceptVerifierTransactionDate,
  applyTransactionDateVerification,
  isCostcoForDateVerification,
  normalizeReceiptDateTimeForVerify,
  parseReceiptDateTimeForVerify,
  requiresTransactionDateVerification,
  resolveFinalTransactionDate,
} from '../supabase/functions/ocr-receipt/transactionDateVerify';

const NOW_MS = Date.parse('2026-08-20T12:00:00+09:00');

describe('B3 transactionDate verification', () => {
  it('A — Sample 081: year conflict preserves valid primary (no silent verifier year replace)', async () => {
    const verifyFn = jest.fn().mockResolvedValue({
      transactionDate: '07/06/2023 11:44:46',
    });

    const out = await applyTransactionDateVerification({
      merchant: 'COSTCO WHOLESALE',
      primaryDate: '07/06/2026 11:44:46',
      items: [{ name: '豪州産モモカツギリ' }],
      nowMs: NOW_MS,
      verifyFn,
    });

    expect(out.verificationRequired).toBe(true);
    expect(out.verifierCalled).toBe(true);
    expect(verifyFn).toHaveBeenCalledTimes(1);
    expect(out.finalTransactionDate).toBe('07/06/2026 11:44:46');
    expect(out.shouldCache).toBe(false);
  });

  it('B — Costco correct primary: verifier confirms same printed date', async () => {
    const verifyFn = jest.fn().mockResolvedValue({
      transactionDate: '06/10/2026 10:50:58',
    });

    const out = await applyTransactionDateVerification({
      merchant: 'Costco',
      primaryDate: '06/10/2026 10:50:58',
      nowMs: NOW_MS,
      verifyFn,
    });

    expect(verifyFn).toHaveBeenCalledTimes(1);
    expect(out.finalTransactionDate).toBe('06/10/2026 10:50:58');
    expect(out.shouldCache).toBe(true);
  });

  it('Receipt080 D2 — verifier conflicting calendar day cannot silently replace valid primary', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '07/05/2023 11:44:46',
      verifierDate: '07/06/2023 11:44:46',
      verifierCallSucceeded: true,
      merchant: 'コストコ',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe('07/05/2023 11:44:46');
    expect(out.acceptOutcome).toBe('primary_verifier_calendar_conflict');
    expect(out.shouldCache).toBe(false);
  });

  it('Receipt080 D1 — same calendar day accepted', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '07/05/2023 11:44:46',
      verifierDate: '07/05/2023 11:44:46',
      verifierCallSucceeded: true,
      merchant: 'コストコ',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe('07/05/2023 11:44:46');
    expect(out.acceptOutcome).toBe('accepted');
    expect(out.shouldCache).toBe(true);
  });

  it('Receipt080 D3 — missing primary uses valid verifier', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: null,
      verifierDate: '07/05/2023 11:44:46',
      verifierCallSucceeded: true,
      merchant: 'コストコ',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe('07/05/2023 11:44:46');
    expect(out.acceptOutcome).toBe('accepted');
    expect(out.shouldCache).toBe(true);
  });

  it('Receipt080 D4 — verifier may reformat same calendar day', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '07/05/2023 11:44:46',
      verifierDate: '2023-07-05 11:44:46',
      verifierCallSucceeded: true,
      merchant: 'コストコ',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe('2023-07-05 11:44:46');
    expect(out.acceptOutcome).toBe('accepted');
    expect(out.shouldCache).toBe(true);
  });

  it('Receipt080 D5 — year conflict preserves primary 2023, no cache', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '07/05/2023 11:44:46',
      verifierDate: '07/05/2024 11:44:46',
      verifierCallSucceeded: true,
      merchant: 'コストコ',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe('07/05/2023 11:44:46');
    expect(out.acceptOutcome).toBe('primary_verifier_calendar_conflict');
    expect(out.shouldCache).toBe(false);
  });

  it('Receipt080 D6 — year conflict preserves primary 2024, no cache', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '07/05/2024 11:44:46',
      verifierDate: '07/05/2023 11:44:46',
      verifierCallSucceeded: true,
      merchant: 'コストコ',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe('07/05/2024 11:44:46');
    expect(out.acceptOutcome).toBe('primary_verifier_calendar_conflict');
    expect(out.shouldCache).toBe(false);
  });

  it('C — Costco primary plausible, verifier null => final null, do not cache', async () => {
    const out = await resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '07/06/2026 11:44:46',
      verifierDate: null,
      verifierCallSucceeded: true,
      merchant: 'Costco',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe(null);
    expect(out.shouldCache).toBe(false);
    expect(out.acceptOutcome).toBe('empty_or_null');
  });

  it('D — Costco verifier malformed/out-of-window => final null, do not cache', () => {
    expect(
      acceptVerifierTransactionDate('not-a-date', 'Costco', NOW_MS)
    ).toBe(null);
    expect(
      acceptVerifierTransactionDate('01/01/2010 10:00:00', 'Costco', NOW_MS)
    ).toBe(null);
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '07/06/2026 11:44:46',
      verifierDate: '01/01/2010 10:00:00',
      verifierCallSucceeded: true,
      merchant: 'Costco',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe(null);
    expect(out.shouldCache).toBe(false);
    expect(out.acceptOutcome).toBe('out_of_window');
  });

  it('E — AEON 029: plausible date => no verifier', async () => {
    const verifyFn = jest.fn();
    const primary = '2026/ 2/21(土) 12:28';

    expect(
      requiresTransactionDateVerification('イオン古川店', primary, [], NOW_MS)
    ).toBe(false);

    const out = await applyTransactionDateVerification({
      merchant: 'イオン古川店',
      primaryDate: primary,
      nowMs: NOW_MS,
      verifyFn,
    });

    expect(out.verifierCalled).toBe(false);
    expect(verifyFn).not.toHaveBeenCalled();
    expect(out.finalTransactionDate).toBe(primary);
  });

  it('F — non-Costco primary null: verifier called and final uses verifier', async () => {
    const verifyFn = jest.fn().mockResolvedValue({
      transactionDate: '2026/ 2/21(土) 12:28',
    });

    expect(requiresTransactionDateVerification('セブン-イレブン', null, [], NOW_MS)).toBe(
      true
    );

    const out = await applyTransactionDateVerification({
      merchant: 'セブン-イレブン',
      primaryDate: null,
      nowMs: NOW_MS,
      verifyFn,
    });

    expect(verifyFn).toHaveBeenCalledTimes(1);
    expect(out.finalTransactionDate).toBe('2026/ 2/21(土) 12:28');
  });

  it('G — non-Costco primary invalid: verifier called and final uses verifier', async () => {
    const verifyFn = jest.fn().mockResolvedValue({
      transactionDate: '2026/03/15 09:30',
    });

    expect(
      requiresTransactionDateVerification('ローソン', 'garbled-date', [], NOW_MS)
    ).toBe(true);

    const out = await applyTransactionDateVerification({
      merchant: 'ローソン',
      primaryDate: 'garbled-date',
      nowMs: NOW_MS,
      verifyFn,
    });

    expect(verifyFn).toHaveBeenCalledTimes(1);
    expect(out.finalTransactionDate).toBe('2026/03/15 09:30');
  });

  it('H — verifier upstream error: final null, skip cache, primary fields untouched by resolver', async () => {
    const verifyFn = jest.fn().mockRejectedValue(new Error('upstream 503'));

    const out = await applyTransactionDateVerification({
      merchant: 'Costco',
      primaryDate: '07/06/2026 11:44:46',
      nowMs: NOW_MS,
      verifyFn,
    });

    expect(out.finalTransactionDate).toBe(null);
    expect(out.shouldCache).toBe(false);
    expect(out.verifierCalled).toBe(true);
  });

  it('Costco detection ignores arbitrary product names containing コストコ', () => {
    expect(isCostcoForDateVerification('イオン古川店', [{ name: 'コストコホットドッグ' }])).toBe(
      false
    );
    expect(
      isCostcoForDateVerification('セブン-イレブン', [{ name: 'MR コストコ コネクション' }])
    ).toBe(false);
    expect(
      requiresTransactionDateVerification(
        'イオン古川店',
        '2026/ 2/21(土) 12:28',
        [{ name: 'コストコホットドッグ' }],
        NOW_MS
      )
    ).toBe(false);
  });

  it('Costco merchant text still triggers directly', () => {
    expect(isCostcoForDateVerification('COSTCO WHOLESALE', [])).toBe(true);
    expect(isCostcoForDateVerification('コストコ', [])).toBe(true);
  });
});

describe('Edge datetime parser parity with client weekday wrappers', () => {
  const tokyo1132 = Date.parse('2026-07-20T11:32:00+09:00');
  const tokyoMidnight = Date.parse('2026-07-20T00:00:00+09:00');
  const merchant = 'synth-market';

  it('Receipt087 〈月〉 keeps Tokyo 11:32 and does not force verification', () => {
    const raw = '2026年 7月20日〈月〉11:32';
    expect(normalizeReceiptDateTimeForVerify(raw)).toBe('2026-07-20 11:32');
    expect(parseReceiptDateTimeForVerify(raw, merchant, NOW_MS)).toBe(tokyo1132);
    expect(parseReceiptDateTimeForVerify(raw, merchant, NOW_MS)).not.toBe(tokyoMidnight);
    expect(
      requiresTransactionDateVerification(merchant, raw, [], NOW_MS)
    ).toBe(false);

    const resolved = resolveFinalTransactionDate({
      verificationRequired: false,
      primaryDate: raw,
      verifierCallSucceeded: false,
      merchant,
      nowMs: NOW_MS,
    });
    expect(resolved.finalTransactionDate).toBe(raw);
    expect(resolved.shouldCache).toBe(true);
  });

  it.each([
    '2026年7月20日(月)11:32',
    '2026年7月20日（ 火 ）11:32',
    '2026年7月20日〈水〉11:32',
    '2026年7月20日<木>11:32',
    '2026年7月20日(金)11:32',
    '2026年7月20日（土）11:32',
    '2026年7月20日〈日〉11:32',
  ])('strips paired weekday wrapper %s', (raw) => {
    expect(normalizeReceiptDateTimeForVerify(raw)).toBe('2026-07-20 11:32');
    expect(parseReceiptDateTimeForVerify(raw, merchant, NOW_MS)).toBe(tokyo1132);
  });

  it.each([
    '2026年7月20日〈商品〉11:32',
    '2026年7月20日(123)11:32',
    '2026年7月20日(月〉11:32',
    '2026年7月20日〈月)11:32',
    '2026年7月20日〈11:32〉',
  ])('fails closed on an unconsumed minute clock: %s', (raw) => {
    expect(normalizeReceiptDateTimeForVerify(raw)).toBe('');
    const parsed = parseReceiptDateTimeForVerify(raw, merchant, NOW_MS);
    expect(parsed).toBeNull();
    expect(parsed).not.toBe(tokyoMidnight);
    expect(acceptVerifierTransactionDate(raw, merchant, NOW_MS)).toBeNull();
  });

  it('fails closed on an unconsumed second clock', () => {
    const raw = '2026年7月20日〈商品〉11:32:45';
    expect(normalizeReceiptDateTimeForVerify(raw)).toBe('');
    const parsed = parseReceiptDateTimeForVerify(raw, merchant, NOW_MS);
    expect(parsed).toBeNull();
    expect(parsed).not.toBe(tokyoMidnight);
    expect(parsed).not.toBe(Date.parse('2026-07-20T11:32:45+09:00'));
  });

  it.each(['2026年7月20日', '2026年7月20日〈商品〉', '2026年7月20日 abc'])(
    'keeps clock-free Japanese text as date-only midnight: %s',
    (raw) => {
      expect(normalizeReceiptDateTimeForVerify(raw)).toBe('2026-07-20 00:00');
      expect(parseReceiptDateTimeForVerify(raw, merchant, NOW_MS)).toBe(tokyoMidnight);
      expect(
        requiresTransactionDateVerification(merchant, raw, [], NOW_MS)
      ).toBe(false);
    }
  );

  it('keeps plain slash, hyphen, and second-precision forms', () => {
    expect(normalizeReceiptDateTimeForVerify('2026/07/20 11:32')).toBe('2026-07-20 11:32');
    expect(parseReceiptDateTimeForVerify('2026/07/20 11:32', merchant, NOW_MS)).toBe(
      tokyo1132
    );
    expect(normalizeReceiptDateTimeForVerify('2026-07-20 11:32')).toBe('2026-07-20 11:32');
    expect(normalizeReceiptDateTimeForVerify('2026年7月20日 11:32:45')).toBe(
      '2026-07-20 11:32:45'
    );
    expect(parseReceiptDateTimeForVerify('2026年7月20日 11:32:45', merchant, NOW_MS)).toBe(
      Date.parse('2026-07-20T11:32:45+09:00')
    );
    expect(normalizeReceiptDateTimeForVerify('2026/ 2/21(土) 12:28')).toBe(
      '2026-02-21 12:28'
    );
  });

  it('does not strip a wrapper that contains more than one weekday', () => {
    const raw = '2026年7月20日〈月火〉11:32';
    expect(normalizeReceiptDateTimeForVerify(raw)).toBe('');
    const parsed = parseReceiptDateTimeForVerify(raw, merchant, NOW_MS);
    expect(parsed).toBeNull();
    expect(parsed).not.toBe(tokyoMidnight);
  });

  it.each([
    '2026年7月20日〈商品〉11:32',
    '2026年7月20日〈商品〉11:32:45',
  ])('requires verification for malformed explicit-clock primary: %s', (raw) => {
    expect(requiresTransactionDateVerification(merchant, raw, [], NOW_MS)).toBe(true);
  });

  it('uses a valid verifier when the primary explicit clock is malformed', async () => {
    const primary = '2026年7月20日〈商品〉11:32';
    const verifierDate = '2026-07-20 11:32';
    const verifyFn = jest.fn().mockResolvedValue({ transactionDate: verifierDate });

    const out = await applyTransactionDateVerification({
      merchant,
      primaryDate: primary,
      nowMs: NOW_MS,
      verifyFn,
    });
    expect(out.verificationRequired).toBe(true);
    expect(out.verifierCalled).toBe(true);
    expect(verifyFn).toHaveBeenCalledTimes(1);
    expect(out.finalTransactionDate).toBe(verifierDate);
    expect(out.finalTransactionDate).not.toBe('2026-07-20 00:00');
    expect(out.shouldCache).toBe(true);
    expect(parseReceiptDateTimeForVerify(String(out.finalTransactionDate), merchant, NOW_MS)).toBe(
      tokyo1132
    );

    expect(
      resolveFinalTransactionDate({
        verificationRequired: true,
        primaryDate: primary,
        verifierDate,
        verifierCallSucceeded: true,
        merchant,
        nowMs: NOW_MS,
      })
    ).toEqual({
      finalTransactionDate: verifierDate,
      shouldCache: true,
      acceptOutcome: 'accepted',
    });
  });

  it('rejects a malformed verifier when the primary explicit clock is malformed', () => {
    const primary = '2026年7月20日〈商品〉11:32';
    const verifierDate = '2026年7月20日〈商品〉11:32';
    const resolved = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: primary,
      verifierDate,
      verifierCallSucceeded: true,
      merchant,
      nowMs: NOW_MS,
    });
    expect(resolved).toEqual({
      finalTransactionDate: null,
      shouldCache: false,
      acceptOutcome: 'unparseable',
    });
    expect(resolved.finalTransactionDate).not.toBe('2026-07-20 00:00');
    expect(parseReceiptDateTimeForVerify(primary, merchant, NOW_MS)).toBeNull();
    expect(parseReceiptDateTimeForVerify(verifierDate, merchant, NOW_MS)).toBeNull();
  });

  it('does not cache when verifier lookup fails for a malformed primary', async () => {
    const primary = '2026年7月20日〈商品〉11:32';
    const verifyFn = jest.fn().mockRejectedValue(new Error('upstream 503'));
    const out = await applyTransactionDateVerification({
      merchant,
      primaryDate: primary,
      nowMs: NOW_MS,
      verifyFn,
    });
    expect(out.verificationRequired).toBe(true);
    expect(out.verifierCalled).toBe(true);
    expect(out.finalTransactionDate).toBeNull();
    expect(out.shouldCache).toBe(false);

    expect(
      resolveFinalTransactionDate({
        verificationRequired: true,
        primaryDate: primary,
        verifierDate: null,
        verifierCallSucceeded: false,
        merchant,
        nowMs: NOW_MS,
      })
    ).toEqual({
      finalTransactionDate: null,
      shouldCache: false,
      acceptOutcome: 'api_failure',
    });
  });

  it.each(['2026/07/20', '2026-07-20'])(
    'keeps slash and hyphen date-only forms at Tokyo midnight: %s',
    (raw) => {
      expect(normalizeReceiptDateTimeForVerify(raw)).toBe('2026-07-20 00:00');
      expect(parseReceiptDateTimeForVerify(raw, merchant, NOW_MS)).toBe(tokyoMidnight);
    }
  );
});

describe('B3 Edge contract (source)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const edgeSource = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/ocr-receipt/index.ts'),
    'utf8'
  );

  it('I — cache v14 stores post-verification analysis; date verify model configured', () => {
    expect(edgeSource).toMatch(/OCR_CACHE_VERSION\s*=\s*15/);
    expect(edgeSource).not.toMatch(/OCR_CACHE_VERSION\s*=\s*14[^\d]/);
    expect(edgeSource).toContain('OCR_DATE_VERIFY_MODEL');
    expect(edgeSource).toContain("gemini-3.5-flash'");
    expect(edgeSource).toContain('buildDateVerifyPrompt');
    expect(edgeSource).toContain('callDateVerifier');
    expect(edgeSource).toContain('resolveFinalTransactionDate');
    expect(edgeSource).toMatch(/if \(shouldCache\)/);
    expect(edgeSource).toContain('Skipping cache: date verification required but no accepted transactionDate');
    expect(edgeSource).toContain('shouldBypassNegativeDateVerificationCache');
    expect(edgeSource).toContain('negative_cache_bypassed');
    expect(edgeSource).toContain('ocr_date_verify');
    expect(edgeSource).not.toContain('07/06/2023');
    expect(edgeSource).not.toContain('07/06/2020');
    expect(edgeSource).toContain('#date-verify');
  });
});
