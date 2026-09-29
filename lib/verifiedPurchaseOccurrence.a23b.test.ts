/**
 * A2.3b exact-ID verified occurrence dry run. Synthetic ids only.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import type { ReceiptRow } from './db';
import { buildEffectivePurchaseTruth } from './purchaseTruthPartition';
import {
  dryRunVerifiedPurchaseOccurrenceRepairWithDb,
  simulateVerifiedOccurrenceDryRunAssignment,
  syntheticDryRunOccurrenceCandidate,
  VERIFIED_OCCURRENCE_DRY_RUN_TRUTH_COLUMNS,
  VerifiedPurchaseOccurrenceDryRunError,
  type VerifiedOccurrenceDryRunDb,
} from './verifiedPurchaseOccurrenceDryRun';

const USER = 'user-synth';
const OTHER = 'user-other';
const VERIFIED_AT = 1_710_000_000_000;

type Stored = ReceiptRow & { user_id: string };

function receipt(id: string, index: number, patch?: Partial<Stored>): Stored {
  const at = Date.parse('2024-01-01T09:00:00+09:00') + index * 86_400_000;
  const total = 100 + index;
  return {
    id,
    created_at: at,
    transaction_at: at,
    transaction_time_precision: 'second',
    image_uri: '',
    merchant_raw: `SHOP-${id}`,
    merchant_normalized: `SHOP-${id}`,
    merchant_type: 'supermarket',
    total,
    tax: 8,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [{ name: `ITEM-${id}`, quantity: 1, lineTotal: total }],
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: USER,
    verified_purchase_occurrence_id: null,
    verified_purchase_occurrence_source: null,
    verified_purchase_occurrence_verified_at: null,
    ...patch,
  };
}

function assigned(id: string, index: number, occurrenceId: string): Stored {
  return receipt(id, index, {
    verified_purchase_occurrence_id: occurrenceId,
    verified_purchase_occurrence_source: 'research_verified',
    verified_purchase_occurrence_verified_at: VERIFIED_AT,
  });
}

function identicalRescan(id: string, createdOffset: number): Stored {
  const at = Date.parse('2024-06-01T09:00:00+09:00');
  return receipt(id, 0, {
    created_at: at + createdOffset,
    transaction_at: at,
    merchant_raw: 'SYNTH-MART',
    merchant_normalized: 'SYNTH-MART',
    total: 480,
    analysis_json: JSON.stringify({
      items: [{ name: 'MILK', quantity: 1, lineTotal: 480 }],
    }),
  });
}

function createReadDb(rows: Stored[]): {
  db: VerifiedOccurrenceDryRunDb & {
    runAsync: () => Promise<never>;
    execAsync: () => Promise<never>;
    withExclusiveTransactionAsync: () => Promise<never>;
  };
  calls: string[];
  snapshot: () => string;
} {
  const calls: string[] = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const snapshot = () =>
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        verified_purchase_occurrence_id: row.verified_purchase_occurrence_id ?? null,
        verified_purchase_occurrence_source:
          row.verified_purchase_occurrence_source ?? null,
        verified_purchase_occurrence_verified_at:
          row.verified_purchase_occurrence_verified_at ?? null,
        total: row.total,
        merchant_raw: row.merchant_raw,
      }))
    );
  const db = {
    async getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]> {
      calls.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) {
        throw new Error(`mutation sql: ${sql}`);
      }
      if (/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(sql)) {
        throw new Error(`mutation sql: ${sql}`);
      }
      const userId = String(params?.[params.length - 1]);
      if (/id IN/i.test(sql)) {
        const ids = (params ?? []).slice(0, -1).map(String);
        return ids
          .map((id) => byId.get(id))
          .filter((row): row is Stored => !!row && row.user_id === userId) as T[];
      }
      return rows.filter((row) => row.user_id === userId) as T[];
    },
    async runAsync(): Promise<never> {
      calls.push('runAsync');
      throw new Error('runAsync');
    },
    async execAsync(): Promise<never> {
      calls.push('execAsync');
      throw new Error('execAsync');
    },
    async withExclusiveTransactionAsync(): Promise<never> {
      calls.push('withExclusiveTransactionAsync');
      throw new Error('withExclusiveTransactionAsync');
    },
  };
  return { db, calls, snapshot };
}

describe('A2.3b verified occurrence exact-ID dry run', () => {
  it('all unassigned → READY_CREATE_NEW and one simulated purchase', async () => {
    const rows = [receipt('syn-a', 1), receipt('syn-b', 2), receipt('syn-c', 3)];
    const { db, calls, snapshot } = createReadDb(rows);
    const beforeRows = snapshot();
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-b', 'syn-c'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('READY_CREATE_NEW');
    expect(result.provenance.map((item) => item.state)).toEqual([
      'unassigned',
      'unassigned',
      'unassigned',
    ]);
    expect(result.simulation).not.toBeNull();
    expect(result.simulation!.simulatedOccurrenceId.startsWith('dryrun_vpo_')).toBe(
      true
    );
    expect(result.simulation!.simulatedOccurrenceIdIsSynthetic).toBe(true);
    expect(result.simulation!.simulatedSource).toBe('user_verified');
    expect(result.simulation!.ownerReceiptCount).toBe(3);
    expect(result.simulation!.selectedEffectiveOccurrenceCountBefore).toBe(3);
    expect(result.simulation!.selectedEffectiveOccurrenceCountAfter).toBe(1);
    expect(result.simulation!.effectivePurchaseDelta).toBe(-2);
    expect(result.simulation!.allSelectedInOneVerifiedActiveOccurrence).toBe(true);
    expect(result.simulation!.unexpectedUnselectedAbsorption).toBe(false);
    expect(result.simulation!.absorbedUnselectedReceiptIds).toEqual([]);
    expect(snapshot()).toBe(beforeRows);
    expect(calls.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect(calls.some((sql) => sql === 'runAsync' || sql === 'execAsync')).toBe(
      false
    );
  });

  it('one existing G plus unassigned → READY_ADOPT_EXISTING', async () => {
    const rows = [assigned('syn-a', 1, 'vpo_g'), receipt('syn-b', 2)];
    const { db } = createReadDb(rows);
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-b'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('READY_ADOPT_EXISTING');
    expect(result.simulation!.simulatedOccurrenceId).toBe('vpo_g');
    expect(result.simulation!.simulatedOccurrenceIdIsSynthetic).toBe(false);
    expect(result.provenance.find((item) => item.receiptId === 'syn-a')).toMatchObject({
      state: 'assigned',
      occurrenceId: 'vpo_g',
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
    });
    expect(result.simulation!.allSelectedInOneVerifiedActiveOccurrence).toBe(true);
    expect(result.simulation!.unexpectedUnselectedAbsorption).toBe(false);
  });

  it('all same G → ALREADY_ASSIGNED without simulation', async () => {
    const rows = [assigned('syn-a', 1, 'vpo_g'), assigned('syn-b', 2, 'vpo_g')];
    const { db, calls } = createReadDb(rows);
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-b'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('ALREADY_ASSIGNED');
    expect(result.simulation).toBeNull();
    expect(result.provenance.every((item) => item.occurrenceId === 'vpo_g')).toBe(
      true
    );
    expect(calls).toHaveLength(1);
  });

  it('G + H → BLOCK_CONFLICT and stays two purchases', async () => {
    const rows = [assigned('syn-a', 1, 'vpo_g'), assigned('syn-b', 2, 'vpo_h')];
    const { db } = createReadDb(rows);
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-b'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('BLOCK_CONFLICT');
    expect(result.conflictOccurrenceIds.sort()).toEqual(['vpo_g', 'vpo_h']);
    expect(result.simulation).toBeNull();
    const truth = buildEffectivePurchaseTruth(rows);
    expect(truth.purchaseByReceiptId.get('syn-a')).not.toBe(
      truth.purchaseByReceiptId.get('syn-b')
    );
  });

  it('malformed partial provenance → BLOCK_INVALID_PROVENANCE', async () => {
    const rows = [
      receipt('syn-a', 1, { verified_purchase_occurrence_id: 'vpo_only' }),
      receipt('syn-b', 2),
    ];
    const { db } = createReadDb(rows);
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-b'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('BLOCK_INVALID_PROVENANCE');
    expect(result.invalidReceiptId).toBe('syn-a');
    expect(result.provenance.find((item) => item.receiptId === 'syn-a')?.state).toBe(
      'invalid'
    );
    expect(result.simulation).toBeNull();
  });

  it('missing exact ID → BLOCK_MISSING_RECEIPT', async () => {
    const { db } = createReadDb([receipt('syn-a', 1)]);
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-missing'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('BLOCK_MISSING_RECEIPT');
    expect(result.missingReceiptIds).toEqual(['syn-missing']);
    expect(result.simulation).toBeNull();
  });

  it('cross-owner ID does not count as found', async () => {
    const { db } = createReadDb([
      receipt('syn-a', 1),
      receipt('syn-other', 2, { user_id: OTHER }),
    ]);
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-other'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('BLOCK_MISSING_RECEIPT');
    expect(result.missingReceiptIds).toEqual(['syn-other']);
  });

  it('duplicate input IDs reject before any read', async () => {
    const { db, calls } = createReadDb([receipt('syn-a', 1), receipt('syn-b', 2)]);
    await expect(
      dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
        userId: USER,
        receiptIds: ['syn-a', 'syn-a'],
        source: 'user_verified',
        nowMs: VERIFIED_AT,
      })
    ).rejects.toBeInstanceOf(VerifiedPurchaseOccurrenceDryRunError);
    expect(calls).toEqual([]);
  });

  it('surfaces a compatible unselected receipt and ignores an incompatible one', async () => {
    const selectedA = identicalRescan('syn-a', 0);
    const selectedB = identicalRescan('syn-b', 1);
    const compatibleU = identicalRescan('syn-u', 2);
    const unrelated = receipt('syn-z', 9);
    const rows = [selectedA, selectedB, compatibleU, unrelated];
    const { db, snapshot } = createReadDb(rows);
    const beforeRows = snapshot();
    const absorbed = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: ['syn-a', 'syn-b'],
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(absorbed.status).toBe('READY_CREATE_NEW');
    expect(absorbed.simulation!.unexpectedUnselectedAbsorption).toBe(true);
    expect(absorbed.simulation!.absorbedUnselectedReceiptIds).toEqual(['syn-u']);
    expect(absorbed.simulation!.simulatedMemberReceiptIds).toEqual(
      expect.arrayContaining(['syn-a', 'syn-b', 'syn-u'])
    );
    expect(absorbed.simulation!.simulatedMemberReceiptIds).not.toContain('syn-z');
    expect(snapshot()).toBe(beforeRows);

    const clean = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(
      createReadDb([selectedA, selectedB, unrelated]).db,
      {
        userId: USER,
        receiptIds: ['syn-a', 'syn-b'],
        source: 'user_verified',
        nowMs: VERIFIED_AT,
      }
    );
    expect(clean.simulation!.unexpectedUnselectedAbsorption).toBe(false);
    expect(clean.simulation!.absorbedUnselectedReceiptIds).toEqual([]);
    expect(clean.simulation!.selectedEffectiveOccurrenceCountAfter).toBe(1);
  });

  it('skips a synthetic id already used by an unrelated assigned receipt', async () => {
    const selected = ['syn-a', 'syn-b'];
    const first = syntheticDryRunOccurrenceCandidate(selected, 0);
    const second = syntheticDryRunOccurrenceCandidate(selected, 1);
    const rows = [
      receipt('syn-a', 1),
      receipt('syn-b', 2),
      assigned('syn-u', 3, first),
    ];
    const { db } = createReadDb(rows);
    const result = await dryRunVerifiedPurchaseOccurrenceRepairWithDb(db, {
      userId: USER,
      receiptIds: selected,
      source: 'user_verified',
      nowMs: VERIFIED_AT,
    });
    expect(result.status).toBe('READY_CREATE_NEW');
    expect(result.simulation!.simulatedOccurrenceId).toBe(second);
    expect(result.simulation!.simulatedOccurrenceId).not.toBe(first);
    expect(result.simulation!.unexpectedUnselectedAbsorption).toBe(false);
    expect(result.simulation!.absorbedUnselectedReceiptIds).toEqual([]);
    expect(result.simulation!.simulatedMemberReceiptIds).not.toContain('syn-u');
    expect(rows.find((row) => row.id === 'syn-u')!.verified_purchase_occurrence_id).toBe(
      first
    );
  });

  it('adopt simulation overlays only unassigned members', () => {
    const t1 = 50;
    const t2 = VERIFIED_AT;
    const existing = assigned('syn-a', 1, 'vpo_g');
    existing.verified_purchase_occurrence_verified_at = t1;
    const pending = receipt('syn-b', 2);
    const { simulation, simulatedUniverse } = simulateVerifiedOccurrenceDryRunAssignment({
      universe: [existing, pending],
      selectedIds: ['syn-a', 'syn-b'],
      overlayReceiptIds: ['syn-b'],
      occurrenceId: 'vpo_g',
      source: 'user_verified',
      verifiedAt: t2,
      synthetic: false,
    });
    expect(simulation.simulatedOccurrenceId).toBe('vpo_g');
    expect(simulation.allSelectedInOneVerifiedActiveOccurrence).toBe(true);
    expect(simulation.selectedEffectiveOccurrenceCountAfter).toBe(1);
    expect(simulatedUniverse[0]).toBe(existing);
    expect(existing.verified_purchase_occurrence_source).toBe('research_verified');
    expect(existing.verified_purchase_occurrence_verified_at).toBe(t1);
    const overlaid = simulatedUniverse[1]!;
    expect(overlaid).not.toBe(pending);
    expect(overlaid.verified_purchase_occurrence_id).toBe('vpo_g');
    expect(overlaid.verified_purchase_occurrence_source).toBe('user_verified');
    expect(overlaid.verified_purchase_occurrence_verified_at).toBe(t2);
    expect(pending.verified_purchase_occurrence_id).toBeNull();
  });

  it('universe select documents the purchase-truth columns', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'verifiedPurchaseOccurrenceDryRun.ts'),
      'utf8'
    );
    const helper = fs.readFileSync(
      path.join(__dirname, 'receiptVerifiedPurchaseOccurrenceSelect.ts'),
      'utf8'
    );
    const sql = source.slice(
      source.indexOf('const UNIVERSE_SELECT_SQL'),
      source.indexOf('export const VERIFIED_OCCURRENCE_DRY_RUN_TRUTH_COLUMNS')
    );
    expect(sql).toContain('verifiedPurchaseOccurrenceColumnsSql()');
    expect(sql).toContain('WHERE user_id = ?');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    for (const column of VERIFIED_OCCURRENCE_DRY_RUN_TRUTH_COLUMNS) {
      const projected = sql.includes(column) || helper.includes(column);
      expect(projected).toBe(true);
    }
  });

  it('does not call assignment and keeps A2.1 reads inside the transaction', () => {
    const assignSource = fs.readFileSync(
      path.join(__dirname, 'verifiedPurchaseOccurrence.ts'),
      'utf8'
    );
    const drySource = fs.readFileSync(
      path.join(__dirname, 'verifiedPurchaseOccurrenceDryRun.ts'),
      'utf8'
    );
    expect(assignSource).toContain('evaluateVerifiedPurchaseOccurrenceAssignment');
    expect(assignSource).toContain('withExclusiveTransactionAsync');
    expect(assignSource.indexOf('withExclusiveTransactionAsync')).toBeLessThan(
      assignSource.indexOf('FROM receipts')
    );
    expect(assignSource).toContain('UPDATE receipts');
    expect(drySource).not.toContain('assignVerifiedPurchaseOccurrenceWithDb');
    expect(drySource).not.toContain('runAsync');
    expect(drySource).not.toContain('replaceSyncOutboxIntent');
  });
});
