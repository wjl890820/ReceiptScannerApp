/**
 * H3-B1 plumbing only. NULL stays legacy v1. Exact 2 round-trips.
 * Product identity still uses today's merchant_normalized formula.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  buildCloudUserReceiptUpsertPayload,
  type LocalReceiptBackupSource,
} from './cloudBackupPayload';
import {
  mapCloudReceiptToLocalInsert,
  type CloudUserReceiptRow,
} from './cloudRestorePayload';
import {
  classifyMerchantScopeGeneration,
  effectiveMerchantScopeGeneration,
  resolveReceiptMerchantScope,
} from './merchantScopeGeneration';
import { scopeMerchantKeyForIdentity } from './productIdentityResolver';
import { deterministicMerchantProductId } from './productIdentityStore';

const DB_SOURCE = fs.readFileSync(path.resolve(__dirname, 'db.ts'), 'utf8');
const RESTORE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, 'cloudRestore.ts'),
  'utf8'
);
const CLOUD_SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../supabase/migrations/011_merchant_scope_generation.sql'
  ),
  'utf8'
);

function localReceipt(
  extra: Partial<LocalReceiptBackupSource> = {}
): LocalReceiptBackupSource {
  return {
    id: 'r1',
    user_id: 'user-1',
    created_at: 1,
    total: 100,
    tax: 0,
    currency: 'JPY',
    analysis_json: '{"merchant":"イオン","total":100}',
    merchant_raw: 'イオン古川店',
    merchant_normalized: 'イオン',
    ...extra,
  };
}

function cloudReceipt(
  extra: Partial<CloudUserReceiptRow> = {}
): CloudUserReceiptRow {
  return {
    id: 'r1',
    user_id: 'user-1',
    created_at: '2024-01-01T00:00:00.000Z',
    total: 100,
    tax: 0,
    currency: 'JPY',
    analysis_json: '{"merchant":"イオン","total":100}',
    merchant_raw: 'イオン古川店',
    merchant_normalized: 'イオン',
    ...extra,
  };
}

const RESTORE_PARAMS = {
  expectedUserId: 'user-1',
  currentInstallationId: 'install-1',
};

describe('H3-B1 merchant scope generation plumbing', () => {
  it('adds a nullable local column with no default and no backfill', () => {
    expect(DB_SOURCE).toContain(
      'ALTER TABLE receipts ADD COLUMN merchant_scope_generation INTEGER'
    );
    expect(DB_SOURCE).not.toMatch(
      /merchant_scope_generation INTEGER NOT NULL/
    );
    expect(DB_SOURCE).not.toMatch(/merchant_scope_generation[^;\n]*DEFAULT/);
    expect(DB_SOURCE).not.toMatch(
      /UPDATE receipts[\s\S]{0,120}merchant_scope_generation/
    );
    const insertStart = DB_SOURCE.indexOf('const insertSql = `');
    const insertEnd = DB_SOURCE.indexOf('const insertParams', insertStart);
    const insertSql = DB_SOURCE.slice(insertStart, insertEnd);
    expect(insertSql).toContain('merchant_scope_generation');
    expect(DB_SOURCE).toContain('MERCHANT_SCOPE_GENERATION_V2');
  });

  it('adds a nullable cloud column that allows only NULL or 2', () => {
    expect(CLOUD_SQL).toContain(
      'ADD COLUMN IF NOT EXISTS merchant_scope_generation INTEGER'
    );
    expect(CLOUD_SQL).not.toMatch(/DEFAULT\s+2/);
    expect(CLOUD_SQL).toMatch(
      /merchant_scope_generation IS NULL[\s\S]*OR merchant_scope_generation = 2/
    );
    expect(CLOUD_SQL).not.toMatch(/UPDATE public\.user_receipts/i);
  });

  it('classifies absence and null as legacy v1, and only exact integer 2 as v2', () => {
    expect(classifyMerchantScopeGeneration(undefined, 'absent')).toEqual({
      state: 'legacy',
      persisted: null,
      effective: 1,
    });
    expect(classifyMerchantScopeGeneration(null, 'present')).toEqual({
      state: 'legacy',
      persisted: null,
      effective: 1,
    });
    expect(classifyMerchantScopeGeneration(2, 'present')).toEqual({
      state: 'v2',
      persisted: 2,
      effective: 2,
    });
    for (const bad of [0, 1, 3, -1, 2.5, Number.NaN, '2', true, 'v2']) {
      expect(classifyMerchantScopeGeneration(bad, 'present').state).toBe(
        'invalid'
      );
      expect(effectiveMerchantScopeGeneration(bad, 'present')).toBe(1);
    }
  });

  it('omits legacy NULL from the cloud upsert and preserves explicit 2', () => {
    const legacy = buildCloudUserReceiptUpsertPayload(localReceipt());
    expect(legacy).not.toHaveProperty('merchant_scope_generation');

    const explicitNull = buildCloudUserReceiptUpsertPayload(
      localReceipt({ merchant_scope_generation: null })
    );
    expect(explicitNull).not.toHaveProperty('merchant_scope_generation');

    const future = buildCloudUserReceiptUpsertPayload(
      localReceipt({ merchant_scope_generation: 2 })
    );
    expect(future.merchant_scope_generation).toBe(2);
  });

  it('rejects malformed local values instead of uploading them as v2', () => {
    expect(() =>
      buildCloudUserReceiptUpsertPayload(
        localReceipt({ merchant_scope_generation: 1 })
      )
    ).toThrow(/malformed merchant_scope_generation/);
    expect(() =>
      buildCloudUserReceiptUpsertPayload(
        localReceipt({ merchant_scope_generation: '2' as unknown as number })
      )
    ).toThrow(/malformed merchant_scope_generation/);
  });

  it('restores a pre-H3-B1 payload and explicit null as local NULL', () => {
    const missing = mapCloudReceiptToLocalInsert(cloudReceipt(), RESTORE_PARAMS);
    expect(missing.merchant_scope_generation).toBeNull();
    expect(
      effectiveMerchantScopeGeneration(missing.merchant_scope_generation, 'present')
    ).toBe(1);

    const nulled = mapCloudReceiptToLocalInsert(
      cloudReceipt({ merchant_scope_generation: null }),
      RESTORE_PARAMS
    );
    expect(nulled.merchant_scope_generation).toBeNull();
  });

  it('round-trips synthetic 2 without putting it in analysis or snapshot JSON', () => {
    const payload = buildCloudUserReceiptUpsertPayload(
      localReceipt({ merchant_scope_generation: 2 })
    );
    const restored = mapCloudReceiptToLocalInsert(
      cloudReceipt({ merchant_scope_generation: payload.merchant_scope_generation }),
      RESTORE_PARAMS
    );
    expect(restored.merchant_scope_generation).toBe(2);
    expect(restored.analysis_json).not.toContain('merchant_scope_generation');
    expect(restored.recognition_snapshot_json ?? '').not.toContain(
      'merchant_scope_generation'
    );
    expect(restored.store_raw).toBeNull();
    expect(restored.store_normalized).toBeNull();
  });

  it('rejects malformed cloud values before a local insert', () => {
    expect(() =>
      mapCloudReceiptToLocalInsert(
        cloudReceipt({ merchant_scope_generation: 3 }),
        RESTORE_PARAMS
      )
    ).toThrow(/malformed merchant_scope_generation/);
    expect(() =>
      mapCloudReceiptToLocalInsert(
        cloudReceipt({
          merchant_scope_generation: '2' as unknown as number,
        }),
        RESTORE_PARAMS
      )
    ).toThrow(/malformed merchant_scope_generation/);
  });

  it('keeps Receipt096 on the legacy イオン endpoint even when generation is 2', () => {
    const comparisonKey = 'cmp';
    const legacyScope = scopeMerchantKeyForIdentity('イオン', 'receipt-096');
    expect(legacyScope).toBe('イオン');
    expect(deterministicMerchantProductId(legacyScope, comparisonKey)).toBe(
      'mp_7a4346ccc274e206'
    );

    const receipt = {
      merchant_raw: 'イオン古川店',
      merchant_normalized: 'イオン',
      merchant_scope_generation: 2 as number | null,
    };
    const evidence = receipt.merchant_normalized ?? receipt.merchant_raw ?? '';
    expect(scopeMerchantKeyForIdentity(evidence, 'receipt-096')).toBe('イオン');
    expect(
      deterministicMerchantProductId(
        scopeMerchantKeyForIdentity(evidence, 'receipt-096'),
        comparisonKey
      )
    ).toBe('mp_7a4346ccc274e206');
    expect(effectiveMerchantScopeGeneration(null, 'present')).toBe(1);
  });

  it('keeps the resolver, DS1, and outbox off the generation column', () => {
    const root = path.resolve(__dirname);
    for (const file of [
      'productIdentityResolver.ts',
      'personalDecisionCloudSync.ts',
      'personalProductIdentitySchema.ts',
      'outboxWakeupScheduler.ts',
    ]) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toContain(
        'merchant_scope_generation'
      );
    }
  });

  it('restores the column in the same receipt insert as the rest of receipt truth', () => {
    expect(RESTORE_SOURCE).toContain('merchant_scope_generation');
    const insertStart = RESTORE_SOURCE.indexOf('const INSERT_RESTORE_SQL');
    const insertEnd = RESTORE_SOURCE.indexOf('function insertParams');
    const insertSql = RESTORE_SOURCE.slice(insertStart, insertEnd);
    expect(insertSql).toContain('merchant_scope_generation');
    expect(insertSql.match(/\?/g)?.length).toBe(32);
  });
});

describe('H3-B2 phase 1 resolveReceiptMerchantScope', () => {
  const yorkSouth = 'ヨークベニマル古川南店';
  const yorkOther = 'ヨークベニマル中新田店';

  it('keeps NULL generation on the legacy イオン scope', () => {
    const scope = resolveReceiptMerchantScope({
      receiptId: 'r-null',
      merchantNormalized: 'イオン',
      merchantScopeGeneration: null,
    });
    expect(scope.generation).toBe(1);
    expect(scope.scopeKind).toBe('legacy_merchant');
    expect(scope.scopeKey).toBe('イオン');
    expect(scope.scopeKey).toBe(
      scopeMerchantKeyForIdentity('イオン', 'r-null')
    );
  });

  it('treats an absent generation like NULL', () => {
    const absent = resolveReceiptMerchantScope({
      receiptId: 'r-absent',
      merchantNormalized: 'イオン',
    });
    const explicitNull = resolveReceiptMerchantScope({
      receiptId: 'r-absent',
      merchantNormalized: 'イオン',
      merchantScopeGeneration: null,
    });
    expect(absent).toEqual(explicitNull);
    expect(absent.generation).toBe(1);
    expect(absent.scopeKey).toBe('イオン');
  });

  it('uses a v2 namespace for a printed store name', () => {
    const scope = resolveReceiptMerchantScope({
      receiptId: 'r-york',
      merchantRaw: yorkSouth,
      merchantScopeGeneration: 2,
    });
    expect(scope.generation).toBe(2);
    expect(scope.scopeKind).toBe('store_observed');
    expect(scope.scopeKey).toBe(`merchant:v2:store:${yorkSouth}`);
    expect(scope.observedStoreHint).toBe('古川南店');
  });

  it('gives the same v2 scope to the same observed store text', () => {
    const a = resolveReceiptMerchantScope({
      receiptId: 'a',
      merchantRaw: yorkSouth,
      merchantScopeGeneration: 2,
    });
    const b = resolveReceiptMerchantScope({
      receiptId: 'b',
      merchantRaw: yorkSouth,
      merchantNormalized: yorkSouth,
      storeRaw: yorkSouth,
      storeNormalized: yorkSouth,
      merchantScopeGeneration: 2,
    });
    expect(a.scopeKey).toBe(b.scopeKey);
  });

  it('separates different observed stores', () => {
    const south = resolveReceiptMerchantScope({
      receiptId: 'south',
      merchantRaw: yorkSouth,
      merchantScopeGeneration: 2,
    });
    const other = resolveReceiptMerchantScope({
      receiptId: 'other',
      merchantRaw: yorkOther,
      merchantScopeGeneration: 2,
    });
    expect(south.scopeKind).toBe('store_observed');
    expect(other.scopeKind).toBe('store_observed');
    expect(south.scopeKey).not.toBe(other.scopeKey);
  });

  it('isolates a v2 chain-only merchant per receipt', () => {
    const scope = resolveReceiptMerchantScope({
      receiptId: 'aeon-1',
      merchantRaw: 'イオン',
      merchantNormalized: 'イオン',
      merchantScopeGeneration: 2,
    });
    expect(scope.generation).toBe(2);
    expect(scope.scopeKind).toBe('receipt_isolated');
    expect(scope.observedStoreHint).toBeNull();
    expect(scope.scopeKey).toBe('merchant:v2:unknown-store:receipt:aeon-1');
    expect(scope.reason).toBe('chain_only_receipt_isolated');
  });

  it('does not share one v2 catalog across chain-only receipts', () => {
    const a = resolveReceiptMerchantScope({
      receiptId: 'aeon-a',
      merchantRaw: 'イオン',
      merchantNormalized: 'イオン',
      merchantScopeGeneration: 2,
    });
    const b = resolveReceiptMerchantScope({
      receiptId: 'aeon-b',
      merchantRaw: 'イオン',
      merchantNormalized: 'イオン',
      merchantScopeGeneration: 2,
    });
    expect(a.scopeKey).not.toBe(b.scopeKey);
  });

  it('never reuses a v1 scope key for the same printed store text', () => {
    const v1 = resolveReceiptMerchantScope({
      receiptId: 'legacy-york',
      merchantRaw: yorkSouth,
      merchantNormalized: yorkSouth,
      merchantScopeGeneration: null,
    });
    const v2 = resolveReceiptMerchantScope({
      receiptId: 'future-york',
      merchantRaw: yorkSouth,
      merchantNormalized: yorkSouth,
      merchantScopeGeneration: 2,
    });
    expect(v1.scopeKey).toBe(yorkSouth);
    expect(v2.scopeKey).not.toBe(v1.scopeKey);
    expect(v2.scopeKey.startsWith('merchant:v2:')).toBe(true);
  });

  it('does not treat a string 2 as v2', () => {
    const scope = resolveReceiptMerchantScope({
      receiptId: 'bad-string',
      merchantRaw: yorkSouth,
      merchantScopeGeneration: '2',
    });
    expect(scope.generation).toBe(1);
    expect(scope.scopeKind).toBe('legacy_merchant');
    expect(scope.scopeKey).toBe(
      scopeMerchantKeyForIdentity(yorkSouth, 'bad-string')
    );
    expect(scope.scopeKey.startsWith('merchant:v2:')).toBe(false);
  });

  it.each([1, 3, Number.NaN, 0, -1, 2.5, true, 'v2'])(
    'fails closed to legacy for generation %p',
    (generation) => {
      const scope = resolveReceiptMerchantScope({
        receiptId: 'bad',
        merchantRaw: yorkSouth,
        merchantNormalized: 'イオン',
        merchantScopeGeneration: generation,
      });
      expect(scope.generation).toBe(1);
      expect(scope.scopeKind).toBe('legacy_merchant');
      expect(scope.scopeKey.startsWith('merchant:v2:')).toBe(false);
      expect(scope.reason).toBe('malformed_generation_legacy_v1');
    }
  );

  it('isolates a blank v2 merchant per receipt', () => {
    const scope = resolveReceiptMerchantScope({
      receiptId: 'blank-1',
      merchantRaw: '   ',
      merchantNormalized: null,
      merchantScopeGeneration: 2,
    });
    expect(scope.scopeKind).toBe('receipt_isolated');
    expect(scope.scopeKey).toBe('merchant:v2:unknown-store:receipt:blank-1');
    expect(scope.reason).toBe('blank_merchant_receipt_isolated');
  });

  it('is deterministic for the same input', () => {
    const input = {
      receiptId: 'same',
      merchantRaw: yorkSouth,
      merchantNormalized: yorkSouth,
      storeRaw: 'ignored-mirror',
      merchantScopeGeneration: 2,
    };
    expect(resolveReceiptMerchantScope(input)).toEqual(
      resolveReceiptMerchantScope(input)
    );
  });

  it('keeps a legacy missing merchant inside the existing per-receipt unknown scope', () => {
    const scope = resolveReceiptMerchantScope({
      receiptId: 'legacy-unknown',
      merchantRaw: null,
      merchantNormalized: null,
      merchantScopeGeneration: null,
    });
    expect(scope.generation).toBe(1);
    expect(scope.scopeKey).toBe('unknown_merchant:receipt:legacy-unknown');
    expect(scope.scopeKey).toBe(
      scopeMerchantKeyForIdentity('', 'legacy-unknown')
    );
  });

  it('does not teach the resolver or save/cloud paths about receipt scope', () => {
    const root = path.resolve(__dirname);
    for (const file of [
      'productIdentityResolver.ts',
      'personalDecisionCloudSync.ts',
      'db.ts',
      'cloudBackupPayload.ts',
      'cloudRestorePayload.ts',
    ]) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toContain(
        'resolveReceiptMerchantScope'
      );
    }
  });
});
