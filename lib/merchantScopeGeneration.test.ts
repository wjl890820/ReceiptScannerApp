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
    expect(insertSql).not.toContain('merchant_scope_generation');
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

  it('does not let identity, DS1, or outbox code read the generation yet', () => {
    const root = path.resolve(__dirname);
    for (const file of [
      'productIdentityResolver.ts',
      'productIdentityConsumer.ts',
      'personalProductEndpointInventory.ts',
      'productPriceHistory.ts',
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
