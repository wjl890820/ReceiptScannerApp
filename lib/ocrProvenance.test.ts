/**
 * P0 Phase 2 — OCR provenance contract tests (pure helpers + Edge wiring contracts).
 */
import * as fs from 'fs';
import * as path from 'path';

import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import {
  buildCacheHitProvenance,
  buildFreshRunProvenance,
  parseProvenanceFeatureFlags,
  persistOcrRun,
  primaryUsageRequestId,
  provenanceToOcrRunRow,
  verifierUsageRequestId,
} from '../supabase/functions/ocr-receipt/ocrProvenance';
import { applyTransactionDateVerification } from '../supabase/functions/ocr-receipt/transactionDateVerify';

const EDGE_OCR_PATH = path.resolve(
  __dirname,
  '../supabase/functions/ocr-receipt/index.ts'
);
const NOW_MS = Date.parse('2026-08-20T12:00:00+09:00');
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function readEdgeSource(): string {
  return fs.readFileSync(EDGE_OCR_PATH, 'utf8');
}

describe('OCR provenance — feature flags', () => {
  it('defaults response enabled and write disabled (opt-in)', () => {
    expect(parseProvenanceFeatureFlags({})).toEqual({
      responseEnabled: true,
      writeEnabled: false,
    });
  });

  it('respects explicit disable', () => {
    expect(
      parseProvenanceFeatureFlags({
        OCR_PROVENANCE_RESPONSE: 'false',
        OCR_PROVENANCE_WRITE: '0',
      })
    ).toEqual({
      responseEnabled: false,
      writeEnabled: false,
    });
  });

  it('respects explicit write enable', () => {
    expect(
      parseProvenanceFeatureFlags({
        OCR_PROVENANCE_WRITE: 'true',
      })
    ).toEqual({
      responseEnabled: true,
      writeEnabled: true,
    });
  });
});

describe('OCR provenance — buildFreshRunProvenance', () => {
  it('1 — cache miss, normal merchant, no date verifier', () => {
    const p = buildFreshRunProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      dateVerifyModel: 'gemini-3.5-flash',
      cacheVersion: 10,
      imageContentHash: 'abc123',
      verificationRequired: false,
      verifierCalled: false,
      verifierCallSucceeded: false,
      primaryDate: '2026/ 2/21(土) 12:28',
      finalTransactionDate: '2026/ 2/21(土) 12:28',
    });

    expect(p.cached).toBe(false);
    expect(p.requestId).toBe(REQUEST_ID);
    expect(p.cacheVersion).toBe(10);
    expect(p.dateVerification.used).toBe(false);
    expect(p.dateVerification.model).toBeNull();
    expect(p.dateVerification.primaryTransactionDate).toBe('2026/ 2/21(土) 12:28');
    expect(p.dateVerification.verifiedTransactionDate).toBeNull();
    expect(p.dateVerification.finalTransactionDate).toBe('2026/ 2/21(土) 12:28');
    expect(p.dateVerification.verifierSucceeded).toBeNull();
  });

  it('2 — Costco / verifier-used path (Sample 081 abstraction)', async () => {
    const verifyFn = jest.fn().mockResolvedValue({
      transactionDate: '07/06/2023 11:44:46',
    });
    const dateOut = await applyTransactionDateVerification({
      merchant: 'COSTCO WHOLESALE',
      primaryDate: '07/06/2026 11:44:46',
      items: [{ name: '豪州産モモカツギリ' }],
      nowMs: NOW_MS,
      verifyFn,
    });

    const p = buildFreshRunProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      dateVerifyModel: 'gemini-3.5-flash',
      cacheVersion: 10,
      imageContentHash: 'hash081',
      verificationRequired: dateOut.verificationRequired,
      verifierCalled: dateOut.verifierCalled,
      verifierCallSucceeded: true,
      primaryDate: '07/06/2026 11:44:46',
      verifierDate: '07/06/2023 11:44:46',
      finalTransactionDate: dateOut.finalTransactionDate,
    });

    expect(p.dateVerification.used).toBe(true);
    expect(p.dateVerification.model).toBe('gemini-3.5-flash');
    expect(p.dateVerification.primaryTransactionDate).toBe('07/06/2026 11:44:46');
    expect(p.dateVerification.verifiedTransactionDate).toBe('07/06/2023 11:44:46');
    expect(p.dateVerification.finalTransactionDate).toBe('07/06/2023 11:44:46');
    expect(p.dateVerification.verifierSucceeded).toBe(true);
  });
});

describe('OCR provenance — cache hit semantics', () => {
  it('3 — does not invent unavailable origin evidence', () => {
    const p = buildCacheHitProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      cacheVersion: 10,
      imageContentHash: 'cached-hash',
      cachedAnalysis: { transactionDate: '07/06/2023 11:44:46' },
    });

    expect(p.cached).toBe(true);
    expect(p.dateVerification.used).toBe(false);
    expect(p.dateVerification.model).toBeNull();
    expect(p.dateVerification.primaryTransactionDate).toBeNull();
    expect(p.dateVerification.verifiedTransactionDate).toBeNull();
    expect(p.dateVerification.finalTransactionDate).toBe('07/06/2023 11:44:46');
    expect(p.dateVerification.verifierSucceeded).toBeNull();
  });
});

describe('OCR provenance — ocr_runs persistence', () => {
  it('4 — authenticated request attempts ocr_runs insert', async () => {
    const inserts: unknown[] = [];
    const supabase = {
      from: (table: string) => ({
        insert: async (row: unknown) => {
          expect(table).toBe('ocr_runs');
          inserts.push(row);
          return { error: null };
        },
      }),
    };

    const p = buildFreshRunProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      dateVerifyModel: 'gemini-3.5-flash',
      cacheVersion: 10,
      imageContentHash: 'h1',
      verificationRequired: false,
      verifierCalled: false,
      verifierCallSucceeded: false,
      primaryDate: '2026/03/01',
      finalTransactionDate: '2026/03/01',
    });

    const result = await persistOcrRun(
      supabase,
      provenanceToOcrRunRow(p, USER_ID),
      true
    );

    expect(result.attempted).toBe(true);
    expect(result.persisted).toBe(true);
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as any).user_id).toBe(USER_ID);
    expect((inserts[0] as any).request_id).toBe(REQUEST_ID);
  });

  it('5 — legacy/no-user: write skipped when disabled (OCR path unaffected at helper level)', async () => {
    const supabase = {
      from: () => ({
        insert: async () => {
          throw new Error('should not insert without user');
        },
      }),
    };

    const p = buildFreshRunProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      dateVerifyModel: 'gemini-3.5-flash',
      cacheVersion: 10,
      imageContentHash: 'h1',
      verificationRequired: false,
      verifierCalled: false,
      verifierCallSucceeded: false,
    });

    const result = await persistOcrRun(
      supabase,
      provenanceToOcrRunRow(p, USER_ID),
      false
    );
    expect(result.attempted).toBe(false);
    expect(result.persisted).toBe(false);
  });

  it('6 — ocr_runs insert failure does not throw (non-fatal)', async () => {
    const supabase = {
      from: () => ({
        insert: async () => ({ error: { code: '42P01', message: 'relation missing' } }),
      }),
    };

    const p = buildFreshRunProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      dateVerifyModel: 'gemini-3.5-flash',
      cacheVersion: 10,
      imageContentHash: 'h1',
      verificationRequired: false,
      verifierCalled: false,
      verifierCallSucceeded: false,
    });

    await expect(
      persistOcrRun(supabase, provenanceToOcrRunRow(p, USER_ID), true)
    ).resolves.toEqual({
      attempted: true,
      persisted: false,
      idempotentHit: false,
    });
  });

  it('9 — duplicate request_id is idempotent (23505)', async () => {
    const supabase = {
      from: () => ({
        insert: async () => ({ error: { code: '23505', message: 'duplicate' } }),
      }),
    };

    const p = buildCacheHitProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      cacheVersion: 10,
      imageContentHash: 'dup',
      cachedAnalysis: {},
    });

    const result = await persistOcrRun(
      supabase,
      provenanceToOcrRunRow(p, USER_ID),
      true
    );
    expect(result.persisted).toBe(true);
    expect(result.idempotentHit).toBe(true);
  });
});

describe('OCR provenance — usage event linkage', () => {
  it('7 — request_id aligns with primary usage event', () => {
    const p = buildFreshRunProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      dateVerifyModel: 'gemini-3.5-flash',
      cacheVersion: 10,
      imageContentHash: 'h',
      verificationRequired: true,
      verifierCalled: true,
      verifierCallSucceeded: true,
      primaryDate: 'x',
      verifierDate: 'y',
      finalTransactionDate: 'y',
    });
    expect(primaryUsageRequestId(p)).toBe(REQUEST_ID);
    expect(primaryUsageRequestId(p)).not.toContain('#date-verify');
  });

  it('8 — verifier usage remains requestId#date-verify', () => {
    const p = buildFreshRunProvenance({
      requestId: REQUEST_ID,
      primaryModel: 'gemini-3.5-flash-lite',
      dateVerifyModel: 'gemini-3.5-flash',
      cacheVersion: 10,
      imageContentHash: 'h',
      verificationRequired: true,
      verifierCalled: true,
      verifierCallSucceeded: true,
    });
    expect(verifierUsageRequestId(p)).toBe(`${REQUEST_ID}#date-verify`);
  });
});

describe('OCR provenance — ocr_runs row honesty', () => {
  it('nullable date_verification_used when unknown on cache hit row', () => {
    const row = provenanceToOcrRunRow(
      buildCacheHitProvenance({
        requestId: REQUEST_ID,
        primaryModel: 'gemini-3.5-flash-lite',
        cacheVersion: 10,
        imageContentHash: 'c',
        cachedAnalysis: { transactionDate: null },
      }),
      USER_ID
    );
    expect(row.date_verification_used).toBe(false);
    expect(row.primary_transaction_date).toBeNull();
    expect(row.verified_transaction_date).toBeNull();
    expect(row.verifier_succeeded).toBeNull();
  });
});

describe('Build 34 semantic regression (analysis unchanged by provenance layer)', () => {
  it('10 — Sample 007 Costco totals/discounts', () => {
    const sample007 = {
      merchant: 'コストコ',
      currency: 'JPY',
      total: 8351,
      tax: 619,
      transactionDate: '2026/01/15 10:00',
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      items: [
        { name: 'A', quantity: 1, unitPrice: 1128, lineTotal: 1128 },
        { name: 'ROCHER ORIGINS CPN', quantity: 1, unitPrice: -600, lineTotal: -600 },
      ],
    };
    const out = normalizeOcrAnalysis(sample007 as any);
    expect(out.total).toBe(8351);
    expect(out.tax).toBe(619);
    expect(out.total).not.toBe(8970);
  });

  it('10 — Sample 029 AEON date passthrough shape', async () => {
    const primary = '2026/ 2/21(土) 12:28';
    const out = await applyTransactionDateVerification({
      merchant: 'イオン古川店',
      primaryDate: primary,
      nowMs: NOW_MS,
      verifyFn: jest.fn(),
    });
    expect(out.finalTransactionDate).toBe(primary);
    expect(out.verifierCalled).toBe(false);
  });

  it('10 — Sample 076 adjacent discount contract', () => {
    const sample076 = {
      merchant: '業務スーパー',
      currency: 'JPY',
      total: 3142,
      tax: 0,
      items: [
        { name: '正宗生煎包 4個', quantity: 4, unitPrice: 439, lineTotal: 1756 },
        { name: '割引 10%', quantity: 1, unitPrice: -38, lineTotal: -38, kind: 'discount' },
        { name: '黒豚肉まん', quantity: 1, unitPrice: 378, lineTotal: 378 },
        { name: '割引 10%', quantity: 1, unitPrice: -38, lineTotal: -38, kind: 'discount' },
      ],
    };
    const out = normalizeOcrAnalysis(sample076 as any);
    expect(out.total).toBe(3142);
    expect(out.items.length).toBeGreaterThanOrEqual(2);
  });

  it('10 — Sample 081 Costco verifier final date abstraction', async () => {
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
    expect(out.finalTransactionDate).toBe('07/06/2023 11:44:46');
  });
});

describe('Edge provenance wiring contract (source)', () => {
  const edgeSource = readEdgeSource();

  it('wires provenance without altering OCR prompt/parser paths', () => {
    expect(edgeSource).toContain("from './ocrProvenance.ts'");
    expect(edgeSource).toContain('buildCacheHitProvenance');
    expect(edgeSource).toContain('buildFreshRunProvenance');
    expect(edgeSource).toContain('attachProvenanceToResponse');
    expect(edgeSource).toContain('OCR_PROVENANCE_WRITE');
    expect(edgeSource).toContain('OCR_PROVENANCE_RESPONSE');
    // OCR freeze: core prompt/date-verify builders remain separate from provenance module
    expect(edgeSource).toContain('function buildOcrPrompt()');
    expect(edgeSource).toContain('function buildDateVerifyPrompt()');
    expect(edgeSource).not.toContain('provenance in buildOcrPrompt');
  });

  it('legacy anon path still requires x-device-id only (no auth mandate)', () => {
    expect(edgeSource).toContain('OCR_DEVICE_ID_REQUIRED');
    expect(edgeSource).toContain('proceeding as anonymous');
    expect(edgeSource).not.toMatch(/reject.*authenticated/i);
  });

  it('usage events still use primary requestId and #date-verify suffix', () => {
    expect(edgeSource).toContain('requestId: `${requestId}#date-verify`');
    expect(edgeSource).toMatch(/recordUsageEvent\(supabase,\s*\{[\s\S]*requestId,/);
  });
});
