/**
 * Gate 1.1 — negative date-verification cache hotfix.
 */
import {
  applyTransactionDateVerification,
  classifyVerifierAcceptOutcome,
  resolveFinalTransactionDate,
  shouldBypassNegativeDateVerificationCache,
} from '../supabase/functions/ocr-receipt/transactionDateVerify';

const NOW_MS = Date.parse('2026-08-20T12:31:31+00:00');

describe('Gate 1.1 shouldCache matrix', () => {
  it('1 — required verifier + accepted date → shouldCache=true', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: null,
      verifierDate: '06/10/2026 10:50:58',
      verifierCallSucceeded: true,
      merchant: 'Costco',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe('06/10/2026 10:50:58');
    expect(out.shouldCache).toBe(true);
    expect(out.acceptOutcome).toBe('accepted');
  });

  it('2 — required verifier + API failure → final null, shouldCache=false', async () => {
    const out = await applyTransactionDateVerification({
      merchant: 'Costco',
      primaryDate: '06/10/2026 10:50:58',
      nowMs: NOW_MS,
      verifyFn: async () => {
        throw new Error('upstream 503');
      },
    });
    expect(out.finalTransactionDate).toBe(null);
    expect(out.shouldCache).toBe(false);
  });

  it('3 — required verifier + successful null → final null, shouldCache=false', () => {
    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '06/10/2026 10:50:58',
      verifierDate: null,
      verifierCallSucceeded: true,
      merchant: 'Costco',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe(null);
    expect(out.shouldCache).toBe(false);
    expect(out.acceptOutcome).toBe('empty_or_null');
  });

  it('4 — required verifier + rejected candidate → final null, shouldCache=false', () => {
    const rejected = classifyVerifierAcceptOutcome('01/01/2010 10:00:00', 'Costco', NOW_MS);
    expect(rejected.accepted).toBe(null);
    expect(rejected.outcome).toBe('out_of_window');

    const out = resolveFinalTransactionDate({
      verificationRequired: true,
      primaryDate: '06/10/2026 10:50:58',
      verifierDate: '01/01/2010 10:00:00',
      verifierCallSucceeded: true,
      merchant: 'Costco',
      nowMs: NOW_MS,
    });
    expect(out.finalTransactionDate).toBe(null);
    expect(out.shouldCache).toBe(false);
    expect(out.acceptOutcome).toBe('out_of_window');
  });

  it('5 — normal merchant without required verification → cache semantics unchanged', async () => {
    const primary = '2026/ 2/21(土) 12:28';
    const out = await applyTransactionDateVerification({
      merchant: 'イオン古川店',
      primaryDate: primary,
      nowMs: NOW_MS,
      verifyFn: jest.fn(),
    });
    expect(out.verificationRequired).toBe(false);
    expect(out.verifierCalled).toBe(false);
    expect(out.finalTransactionDate).toBe(primary);
    expect(out.shouldCache).toBe(true);
  });
});

describe('Gate 1.1 negative cache bypass', () => {
  it('6 — valid Costco cached date → do not bypass', () => {
    expect(
      shouldBypassNegativeDateVerificationCache(
        {
          merchant: 'COSTCO WHOLESALE',
          transactionDate: '07/06/2023 11:44:46',
          items: [{ name: 'ITEM' }],
        },
        NOW_MS
      )
    ).toBe(false);
  });

  it('7 — Costco cached transactionDate=null → bypass (fresh OCR/verifier required)', () => {
    expect(
      shouldBypassNegativeDateVerificationCache(
        {
          merchant: 'COSTCO WHOLESALE',
          transactionDate: null,
          items: [{ name: 'リノールサラダ油' }],
          total: 24622,
        } as any,
        NOW_MS
      )
    ).toBe(true);
  });

  it('8 — stale negative cache + fresh accepted verifier → return accepted, may cache', async () => {
    // Bypass decision on stale row:
    expect(
      shouldBypassNegativeDateVerificationCache({
        merchant: 'Costco',
        transactionDate: null,
        items: [],
      })
    ).toBe(true);

    const fresh = await applyTransactionDateVerification({
      merchant: 'Costco',
      primaryDate: null,
      nowMs: NOW_MS,
      verifyFn: async () => ({ transactionDate: '06/10/2026 10:50:58' }),
    });
    expect(fresh.finalTransactionDate).toBe('06/10/2026 10:50:58');
    expect(fresh.shouldCache).toBe(true);
  });

  it('9 — stale negative cache + fresh verifier null → return null, no negative cache write', async () => {
    expect(
      shouldBypassNegativeDateVerificationCache({
        merchant: 'Costco',
        transactionDate: '',
        items: [],
      })
    ).toBe(true);

    const fresh = await applyTransactionDateVerification({
      merchant: 'Costco',
      primaryDate: '06/10/2026 10:50:58',
      nowMs: NOW_MS,
      verifyFn: async () => ({ transactionDate: null }),
    });
    expect(fresh.finalTransactionDate).toBe(null);
    expect(fresh.shouldCache).toBe(false);
  });

  it('10 — non-required null date cache is not treated as required negative bypass', () => {
    // AEON with usable date → no bypass
    expect(
      shouldBypassNegativeDateVerificationCache({
        merchant: 'イオン古川店',
        transactionDate: '2026/ 2/21(土) 12:28',
        items: [],
      }, NOW_MS)
    ).toBe(false);
  });
});

describe('Gate 1.1 edge contract + regression freeze', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const edgeSource = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/ocr-receipt/index.ts'),
    'utf8'
  );

  it('10 — response cached flag: bypass path falls through; fresh returns cached:false', () => {
    expect(edgeSource).toContain('shouldBypassNegativeDateVerificationCache');
    expect(edgeSource).toContain('negativeCacheBypassed');
    expect(edgeSource).toMatch(/cached:\s*false/);
    // Bypass must not return early with cached:true for that branch
    expect(edgeSource).toContain('Fall through to fresh OCR + verifier');
  });

  it('11 — safe diagnostic logging omits items/image/auth secrets', () => {
    expect(edgeSource).toContain("tag: 'ocr_date_verify'");
    expect(edgeSource).toContain('primaryTransactionDate');
    expect(edgeSource).toContain('verifierCandidate');
    expect(edgeSource).toContain('acceptOutcome');
    expect(edgeSource).toContain('finalTransactionDate');
    // Must not dump payload / items into the diagnostic helper
    const diagFn = edgeSource.slice(
      edgeSource.indexOf('function logDateVerifyDiagnostic'),
      edgeSource.indexOf('function logDateVerifyDiagnostic') + 900
    );
    expect(diagFn).not.toContain('imageBase64');
    expect(diagFn).not.toContain('items');
    expect(diagFn).not.toContain('Bearer');
    expect(diagFn).not.toContain('SERVICE_ROLE');
    expect(diagFn).not.toContain('identityToken');
  });

  it('12 — Sample 081 Costco accepted date still caches', async () => {
    const out = await applyTransactionDateVerification({
      merchant: 'COSTCO WHOLESALE',
      primaryDate: '07/06/2026 11:44:46',
      items: [{ name: '豪州産モモカツギリ' }],
      nowMs: NOW_MS,
      verifyFn: async () => ({ transactionDate: '07/06/2023 11:44:46' }),
    });
    expect(out.finalTransactionDate).toBe('07/06/2023 11:44:46');
    expect(out.shouldCache).toBe(true);
  });

  it('13 — Sample 007 Costco still requires verification (no hardcode)', () => {
    expect(edgeSource).not.toContain('Sample 077');
    expect(edgeSource).not.toContain('06/10/2026');
    expect(edgeSource).toMatch(/OCR_CACHE_VERSION\s*=\s*10/);
  });

  it('14 — Sample 029 AEON still skips verifier when date plausible', async () => {
    const verifyFn = jest.fn();
    const out = await applyTransactionDateVerification({
      merchant: 'イオン古川店',
      primaryDate: '2026/ 2/21(土) 12:28',
      nowMs: NOW_MS,
      verifyFn,
    });
    expect(out.verifierCalled).toBe(false);
    expect(out.shouldCache).toBe(true);
    expect(out.finalTransactionDate).toBe('2026/ 2/21(土) 12:28');
  });

  it('15 — Sample 076 non-Costco plausible path unchanged (no required verify)', async () => {
    const out = await applyTransactionDateVerification({
      merchant: '業務スーパー古川店',
      primaryDate: '2026年 8月10日(月)17:43',
      nowMs: NOW_MS,
      verifyFn: jest.fn(),
    });
    expect(out.verificationRequired).toBe(false);
    expect(out.shouldCache).toBe(true);
  });
});
