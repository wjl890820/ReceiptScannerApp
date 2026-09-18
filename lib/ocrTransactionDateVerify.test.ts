/**
 * B3 transactionDate verification — deterministic trigger/acceptance tests.
 */
import {
  acceptVerifierTransactionDate,
  applyTransactionDateVerification,
  isCostcoForDateVerification,
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
