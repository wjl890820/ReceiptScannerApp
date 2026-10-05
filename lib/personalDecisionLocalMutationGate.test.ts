/**
 * Production personal-decision local mutation gate.
 */
/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(),
}));

import { buildProductAttributes } from './productIdentityContract';
import { buildPersonalMerchantProductEndpointV1 } from './personalProductIdentityContract';
import { withPersonalDecisionLocalMutationGate } from './personalDecisionLocalMutationGate';
import {
  createMemoryPersonalProductIdentityDatabase,
  recordPersonalProductIdentityDecisionWithDb,
} from './personalProductIdentityRepository';

function endpoint(id: string) {
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: id,
    merchantScopeKey: 'lawson',
    comparisonKey: `cmp-${id}`,
    attributes: buildProductAttributes([]),
  });
}

describe('personal decision local mutation gate', () => {
  it('lets the next operation enter after a rejected callback', async () => {
    await expect(
      withPersonalDecisionLocalMutationGate(async () => {
        throw new Error('gate boom');
      })
    ).rejects.toThrow('gate boom');

    let ran = false;
    await withPersonalDecisionLocalMutationGate(async () => {
      ran = true;
    });
    expect(ran).toBe(true);

    const db = createMemoryPersonalProductIdentityDatabase();
    const left = endpoint('mp_a');
    const right = endpoint('mp_b');
    const recorded = await recordPersonalProductIdentityDecisionWithDb(
      db,
      'user:test-owner',
      left,
      right,
      'same_product',
      { nowMs: 10, currentEndpoints: new Map([['mp_a', left], ['mp_b', right]]) }
    );
    expect(recorded).toEqual({ ok: true, outcome: 'created' });
    expect(db.rows.size).toBe(1);
    expect(db.kv.get('personal_decision_backup_dirty_v1:test-owner')).toBe('1');
    expect(db.kv.get('personal_decision_backup_generation_v1:test-owner')).toBe('1');
  });
});
