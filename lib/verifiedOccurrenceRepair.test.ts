/**
 * A2.3c-2 exact-ID verified occurrence repair operator. Synthetic ids only.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  getReceiptsDatabase: jest.fn(),
}));
jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => ({ ran: false })),
}));

import * as fs from 'fs';
import * as path from 'path';

import { userIdFromReadyOwnerScope } from './receiptOwnershipScope';
import type { LocalReceiptOwnerScope } from './receiptOwnershipScope';
import {
  executeVerifiedOccurrenceRepairWithDb,
  isVerifiedOccurrenceRepairExecutionAllowed,
  previewVerifiedOccurrenceRepairForCurrentOwner,
  type VerifiedOccurrenceRepairDb,
} from './verifiedOccurrenceRepair';
import type { VerifiedOccurrenceDryRunResult } from './verifiedPurchaseOccurrenceDryRun';
import {
  isVerifiedOccurrenceRepairAssignEnabled,
  parseVerifiedOccurrenceRepairIdInput,
  VERIFIED_OCCURRENCE_REPAIR_MAX_RECEIPT_IDS,
  verifiedOccurrenceRepairCloudRequestFailureMessage,
  verifiedOccurrenceRepairConfirmMessage,
  verifiedOccurrenceRepairVerificationFailureMessage,
} from './verifiedOccurrenceRepairInput';
import { shouldShowAnalysisDDiagnosticsEntry } from './analysisDDiagnosticsAccess';

const USER_SCOPE: LocalReceiptOwnerScope = {
  status: 'ready',
  ownerKey: 'user:user-synth',
  receiptWhereSql: 'receipts.user_id = ?',
  itemWhereSql: 'receipts.user_id = ?',
  params: ['user-synth'],
};

const INSTALL_SCOPE: LocalReceiptOwnerScope = {
  status: 'ready',
  ownerKey: 'installation:inst-synth',
  receiptWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
  itemWhereSql: 'receipts.user_id IS NULL AND receipts.installation_id = ?',
  params: ['inst-synth'],
};

function repairDb(): VerifiedOccurrenceRepairDb {
  return { getAllAsync: async () => [] } as unknown as VerifiedOccurrenceRepairDb;
}

function simulation(
  patch?: Partial<NonNullable<VerifiedOccurrenceDryRunResult['simulation']>>
): NonNullable<VerifiedOccurrenceDryRunResult['simulation']> {
  return {
    simulatedOccurrenceId: 'dryrun_vpo_test',
    simulatedOccurrenceIdIsSynthetic: true,
    simulatedSource: 'user_verified',
    simulatedVerifiedAt: 1,
    ownerReceiptCount: 10,
    effectivePurchaseCountBefore: 8,
    effectivePurchaseCountAfter: 7,
    effectivePurchaseDelta: -1,
    selectedReceiptCount: 2,
    selectedEffectiveOccurrenceCountBefore: 2,
    selectedEffectiveOccurrenceCountAfter: 1,
    simulatedMemberReceiptIds: ['syn-a', 'syn-b'],
    allSelectedInOneVerifiedActiveOccurrence: true,
    absorbedUnselectedReceiptIds: [],
    unexpectedUnselectedAbsorption: false,
    ...patch,
  };
}

function dryRunResult(
  status: VerifiedOccurrenceDryRunResult['status'],
  patch?: Partial<VerifiedOccurrenceDryRunResult>
): VerifiedOccurrenceDryRunResult {
  const ready = status === 'READY_CREATE_NEW' || status === 'READY_ADOPT_EXISTING';
  return {
    status,
    source: 'user_verified',
    provenance:
      status === 'ALREADY_ASSIGNED'
        ? [
            {
              receiptId: 'syn-a',
              state: 'assigned',
              occurrenceId: 'vpo_existing',
              source: 'user_verified',
              verifiedAt: 1,
              invalidReason: null,
            },
            {
              receiptId: 'syn-b',
              state: 'assigned',
              occurrenceId: 'vpo_existing',
              source: 'user_verified',
              verifiedAt: 1,
              invalidReason: null,
            },
          ]
        : [],
    missingReceiptIds: [],
    conflictOccurrenceIds: [],
    invalidReceiptId: null,
    simulation: ready ? simulation() : null,
    ...patch,
  };
}

describe('verified occurrence repair operator', () => {
  it('blocks when the current owner is unavailable or installation-scoped', async () => {
    const getDatabase = jest.fn();
    const dryRun = jest.fn();
    const unavailable = await previewVerifiedOccurrenceRepairForCurrentOwner(
      ['syn-a', 'syn-b'],
      {
        resolveOwnerScope: async () => ({ status: 'owner_unavailable', reason: 'auth_unstable' }),
        getDatabase,
        dryRun,
      }
    );
    expect(unavailable).toEqual({
      status: 'BLOCKED_OWNER',
      reason: 'auth_unstable',
      executionAllowed: false,
    });
    const installed = await previewVerifiedOccurrenceRepairForCurrentOwner(
      ['syn-a', 'syn-b'],
      {
        resolveOwnerScope: async () => INSTALL_SCOPE,
        getDatabase,
        dryRun,
      }
    );
    expect(installed.status).toBe('BLOCKED_OWNER');
    if (installed.status === 'BLOCKED_OWNER') {
      expect(installed.reason).toBe('installation_owner');
    }
    expect(getDatabase).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
    expect(userIdFromReadyOwnerScope(INSTALL_SCOPE)).toBeNull();
    expect(userIdFromReadyOwnerScope(USER_SCOPE)).toBe('user-synth');
  });

  it('previews with the resolved user id and user_verified', async () => {
    const dryRun = jest.fn(async () => dryRunResult('READY_CREATE_NEW'));
    const result = await previewVerifiedOccurrenceRepairForCurrentOwner(
      ['syn-a', 'syn-b'],
      {
        resolveOwnerScope: async () => USER_SCOPE,
        getDatabase: async () => repairDb(),
        dryRun,
      }
    );
    expect(dryRun).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-synth',
      receiptIds: ['syn-a', 'syn-b'],
      source: 'user_verified',
    });
    expect(result.status).toBe('PREVIEW');
    if (result.status === 'PREVIEW') expect(result.executionAllowed).toBe(true);
  });

  it('allows only a safe create or adopt simulation', () => {
    expect(isVerifiedOccurrenceRepairExecutionAllowed(dryRunResult('READY_CREATE_NEW'))).toBe(
      true
    );
    expect(isVerifiedOccurrenceRepairExecutionAllowed(dryRunResult('READY_ADOPT_EXISTING'))).toBe(
      true
    );
    expect(
      isVerifiedOccurrenceRepairExecutionAllowed(
        dryRunResult('READY_CREATE_NEW', {
          simulation: simulation({ unexpectedUnselectedAbsorption: true }),
        })
      )
    ).toBe(false);
    expect(
      isVerifiedOccurrenceRepairExecutionAllowed(
        dryRunResult('READY_CREATE_NEW', {
          simulation: simulation({ absorbedUnselectedReceiptIds: ['syn-u'] }),
        })
      )
    ).toBe(false);
    expect(
      isVerifiedOccurrenceRepairExecutionAllowed(
        dryRunResult('READY_CREATE_NEW', {
          simulation: simulation({ allSelectedInOneVerifiedActiveOccurrence: false }),
        })
      )
    ).toBe(false);
    expect(isVerifiedOccurrenceRepairExecutionAllowed(dryRunResult('BLOCK_CONFLICT'))).toBe(
      false
    );
    expect(
      isVerifiedOccurrenceRepairExecutionAllowed(dryRunResult('BLOCK_INVALID_PROVENANCE'))
    ).toBe(false);
    expect(
      isVerifiedOccurrenceRepairExecutionAllowed(dryRunResult('BLOCK_MISSING_RECEIPT'))
    ).toBe(false);
    expect(isVerifiedOccurrenceRepairExecutionAllowed(dryRunResult('ALREADY_ASSIGNED'))).toBe(
      false
    );
  });

  it('re-previews on execute and assigns only a still-safe group', async () => {
    const db = repairDb();
    const flush = jest.fn(async () => undefined);
    const dryRun = jest.fn(async () => dryRunResult('READY_CREATE_NEW'));
    await previewVerifiedOccurrenceRepairForCurrentOwner(['syn-a', 'syn-b'], {
      resolveOwnerScope: async () => USER_SCOPE,
      getDatabase: async () => db,
      dryRun,
    });
    let phase = 0;
    dryRun.mockImplementation(async () => {
      phase += 1;
      if (phase === 1) return dryRunResult('READY_CREATE_NEW');
      return dryRunResult('ALREADY_ASSIGNED', {
        provenance: [
          {
            receiptId: 'syn-a',
            state: 'assigned',
            occurrenceId: 'vpo_made',
            source: 'user_verified',
            verifiedAt: 2,
            invalidReason: null,
          },
          {
            receiptId: 'syn-b',
            state: 'assigned',
            occurrenceId: 'vpo_made',
            source: 'user_verified',
            verifiedAt: 2,
            invalidReason: null,
          },
        ],
      });
    });
    const assign = jest.fn(async (_db: unknown, _params: unknown) => ({
      occurrenceId: 'vpo_made',
      source: 'user_verified' as const,
      changedReceiptIds: ['syn-a', 'syn-b'],
      unchangedReceiptIds: [] as string[],
    }));

    const executed = await executeVerifiedOccurrenceRepairWithDb(
      db,
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      { dryRun, assign, requestCloudBackupFlush: flush }
    );
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0]?.[1]).toEqual({
      userId: 'user-synth',
      receiptIds: ['syn-a', 'syn-b'],
      source: 'user_verified',
    });
    expect(executed.status).toBe('ASSIGNED');
    if (executed.status === 'ASSIGNED') {
      expect(executed.occurrenceId).toBe('vpo_made');
      expect(executed.postVerificationStatus).toBe('ALREADY_ASSIGNED');
      expect(executed.cloudSyncRequestStatus).toBe('requested');
      expect(executed.cloudSyncRequestError).toBeNull();
    }
    expect(flush).toHaveBeenCalledTimes(1);
    expect(dryRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not assign when the fresh dry run is unsafe or already complete', async () => {
    const db = repairDb();
    const flush = jest.fn(async () => undefined);
    const assign = jest.fn();
    const unsafe = await executeVerifiedOccurrenceRepairWithDb(
      db,
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      {
        dryRun: async () =>
          dryRunResult('READY_CREATE_NEW', {
            simulation: simulation({ unexpectedUnselectedAbsorption: true, absorbedUnselectedReceiptIds: ['syn-u'] }),
          }),
        assign,
        requestCloudBackupFlush: flush,
      }
    );
    expect(unsafe.status).toBe('NOT_ELIGIBLE');
    expect(assign).not.toHaveBeenCalled();

    const done = await executeVerifiedOccurrenceRepairWithDb(
      db,
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      {
        dryRun: async () => dryRunResult('ALREADY_ASSIGNED'),
        assign,
        requestCloudBackupFlush: flush,
      }
    );
    expect(done.status).toBe('ALREADY_COMPLETE');
    if (done.status === 'ALREADY_COMPLETE') {
      expect(done.occurrenceId).toBe('vpo_existing');
      expect(done.cloudSyncRequestStatus).toBe('not_needed');
      expect(done.cloudSyncRequestError).toBeNull();
    }
    expect(assign).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('still flushes when post-verification fails or throws after a committed change', async () => {
    const flush = jest.fn(async () => undefined);
    let calls = 0;
    const conflict = await executeVerifiedOccurrenceRepairWithDb(
      repairDb(),
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      {
        dryRun: async () => {
          calls += 1;
          if (calls === 1) return dryRunResult('READY_CREATE_NEW');
          return dryRunResult('BLOCK_CONFLICT');
        },
        assign: async () => ({
          occurrenceId: 'vpo_made',
          source: 'user_verified',
          changedReceiptIds: ['syn-a'],
          unchangedReceiptIds: ['syn-b'],
        }),
        requestCloudBackupFlush: flush,
      }
    );
    expect(conflict.status).toBe('VERIFICATION_FAILED');
    if (conflict.status === 'VERIFICATION_FAILED') {
      expect(conflict.localAssignmentCommitted).toBe(true);
      expect(conflict.occurrenceId).toBe('vpo_made');
      expect(conflict.changedReceiptIds).toEqual(['syn-a']);
      expect(conflict.postVerificationStatus).toBe('BLOCK_CONFLICT');
      expect(conflict.cloudSyncRequestStatus).toBe('requested');
      expect(conflict.cloudSyncRequestError).toBeNull();
    }
    expect(flush).toHaveBeenCalledTimes(1);

    const flushAfterThrow = jest.fn(async () => undefined);
    let thrownReads = 0;
    const thrown = await executeVerifiedOccurrenceRepairWithDb(
      repairDb(),
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      {
        dryRun: async () => {
          thrownReads += 1;
          if (thrownReads === 1) return dryRunResult('READY_CREATE_NEW');
          throw new Error('verify read failed');
        },
        assign: async () => ({
          occurrenceId: 'vpo_made',
          source: 'user_verified',
          changedReceiptIds: ['syn-a'],
          unchangedReceiptIds: ['syn-b'],
        }),
        requestCloudBackupFlush: flushAfterThrow,
      }
    );
    expect(thrown.status).toBe('VERIFICATION_FAILED');
    if (thrown.status === 'VERIFICATION_FAILED') {
      expect(thrown.localAssignmentCommitted).toBe(true);
      expect(thrown.postVerificationStatus).toBe('THROWN');
      expect(thrown.verificationError).toBe('verify read failed');
      expect(thrown.cloudSyncRequestStatus).toBe('requested');
    }
    expect(flushAfterThrow).toHaveBeenCalledTimes(1);
  });

  it('keeps ASSIGNED when the cloud flush request throws', async () => {
    let reads = 0;
    const result = await executeVerifiedOccurrenceRepairWithDb(
      repairDb(),
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      {
        dryRun: async () => {
          reads += 1;
          if (reads === 1) return dryRunResult('READY_CREATE_NEW');
          return dryRunResult('ALREADY_ASSIGNED', {
            provenance: [
              {
                receiptId: 'syn-a',
                state: 'assigned',
                occurrenceId: 'vpo_made',
                source: 'user_verified',
                verifiedAt: 2,
                invalidReason: null,
              },
              {
                receiptId: 'syn-b',
                state: 'assigned',
                occurrenceId: 'vpo_made',
                source: 'user_verified',
                verifiedAt: 2,
                invalidReason: null,
              },
            ],
          });
        },
        assign: async () => ({
          occurrenceId: 'vpo_made',
          source: 'user_verified',
          changedReceiptIds: ['syn-a', 'syn-b'],
          unchangedReceiptIds: [],
        }),
        requestCloudBackupFlush: async () => {
          throw new Error('flush unavailable');
        },
      }
    );
    expect(result.status).toBe('ASSIGNED');
    if (result.status === 'ASSIGNED') {
      expect(result.occurrenceId).toBe('vpo_made');
      expect(result.changedReceiptIds).toEqual(['syn-a', 'syn-b']);
      expect(result.postVerificationStatus).toBe('ALREADY_ASSIGNED');
      expect(result.cloudSyncRequestStatus).toBe('request_failed');
      expect(result.cloudSyncRequestError).toBe('flush unavailable');
    }
  });

  it('reports both verification and cloud request failures after commit', async () => {
    let reads = 0;
    const result = await executeVerifiedOccurrenceRepairWithDb(
      repairDb(),
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      {
        dryRun: async () => {
          reads += 1;
          if (reads === 1) return dryRunResult('READY_CREATE_NEW');
          return dryRunResult('BLOCK_CONFLICT');
        },
        assign: async () => ({
          occurrenceId: 'vpo_made',
          source: 'user_verified',
          changedReceiptIds: ['syn-b'],
          unchangedReceiptIds: ['syn-a'],
        }),
        requestCloudBackupFlush: async () => {
          throw new Error('flush also failed');
        },
      }
    );
    expect(result.status).toBe('VERIFICATION_FAILED');
    if (result.status === 'VERIFICATION_FAILED') {
      expect(result.localAssignmentCommitted).toBe(true);
      expect(result.postVerificationStatus).toBe('BLOCK_CONFLICT');
      expect(result.verificationError).toContain('BLOCK_CONFLICT');
      expect(result.cloudSyncRequestStatus).toBe('request_failed');
      expect(result.cloudSyncRequestError).toBe('flush also failed');
    }
  });

  it('does not flush when assignment changes no rows', async () => {
    const flush = jest.fn();
    let reads = 0;
    const result = await executeVerifiedOccurrenceRepairWithDb(
      repairDb(),
      { userId: 'user-synth', receiptIds: ['syn-a', 'syn-b'] },
      {
        dryRun: async () => {
          reads += 1;
          if (reads === 1) return dryRunResult('READY_CREATE_NEW');
          return dryRunResult('ALREADY_ASSIGNED', {
            provenance: [
              {
                receiptId: 'syn-a',
                state: 'assigned',
                occurrenceId: 'vpo_made',
                source: 'user_verified',
                verifiedAt: 2,
                invalidReason: null,
              },
              {
                receiptId: 'syn-b',
                state: 'assigned',
                occurrenceId: 'vpo_made',
                source: 'user_verified',
                verifiedAt: 2,
                invalidReason: null,
              },
            ],
          });
        },
        assign: async () => ({
          occurrenceId: 'vpo_made',
          source: 'user_verified',
          changedReceiptIds: [],
          unchangedReceiptIds: ['syn-a', 'syn-b'],
        }),
        requestCloudBackupFlush: flush,
      }
    );
    expect(result.status).toBe('ASSIGNED');
    if (result.status === 'ASSIGNED') {
      expect(result.changedReceiptIds).toEqual([]);
      expect(result.cloudSyncRequestStatus).toBe('not_needed');
    }
    expect(flush).not.toHaveBeenCalled();
  });

  it('parses exact lines and rejects unsafe input', () => {
    const parsed = parseVerifiedOccurrenceRepairIdInput('syn-a\n\nsyn-b\n');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.receiptIds).toEqual(['syn-a', 'syn-b']);
    const duplicate = parseVerifiedOccurrenceRepairIdInput('syn-a\nsyn-a');
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.reason).toBe('duplicate');
    const tooFew = parseVerifiedOccurrenceRepairIdInput('syn-a\n');
    expect(tooFew.ok).toBe(false);
    if (!tooFew.ok) expect(tooFew.reason).toBe('too_few');
    const padded = parseVerifiedOccurrenceRepairIdInput('  syn-a\nsyn-b');
    expect(padded.ok).toBe(false);
    if (!padded.ok) expect(padded.reason).toBe('invalid_id');
    const many = Array.from(
      { length: VERIFIED_OCCURRENCE_REPAIR_MAX_RECEIPT_IDS + 1 },
      (_, index) => `syn-${index}`
    ).join('\n');
    const tooMany = parseVerifiedOccurrenceRepairIdInput(many);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toBe('too_many');
  });

  it('invalidates assign when the draft changes and gates the validation entry', () => {
    expect(
      isVerifiedOccurrenceRepairAssignEnabled({
        draftText: 'syn-a\nsyn-b',
        previewDraftText: 'syn-a\nsyn-b',
        executionAllowed: true,
      })
    ).toBe(true);
    expect(
      isVerifiedOccurrenceRepairAssignEnabled({
        draftText: 'syn-a\nsyn-c',
        previewDraftText: 'syn-a\nsyn-b',
        executionAllowed: true,
      })
    ).toBe(false);
    expect(shouldShowAnalysisDDiagnosticsEntry(false)).toBe(false);
    expect(shouldShowAnalysisDDiagnosticsEntry(true)).toBe(true);

    const settings = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
      'utf8'
    );
    const screen = fs.readFileSync(
      path.join(__dirname, '../app/verified-occurrence-repair.tsx'),
      'utf8'
    );
    const operator = fs.readFileSync(
      path.join(__dirname, 'verifiedOccurrenceRepair.ts'),
      'utf8'
    );
    expect(settings).toContain('showAnalysisDDiagnostics');
    expect(settings).toContain('Verified Occurrence Repair');
    expect(settings).toContain('/verified-occurrence-repair');
    expect(settings).not.toMatch(/\{__DEV__\s*\?[\s\S]*Verified Occurrence Repair/);
    const beforeInternal =
      settings.split('{showAnalysisDDiagnostics || showExperimentSnapshot ?')[0] ?? '';
    expect(beforeInternal).not.toContain('Verified Occurrence Repair');
    expect(screen).toContain('One exact receipt ID per line');
    expect(screen).toContain('isVerifiedOccurrenceRepairAssignEnabled');
    expect(screen).toContain('isAnalysisDDiagnosticsEnabled');
    expect(verifiedOccurrenceRepairConfirmMessage(7)).toContain(
      'The receipt records will not be deleted.'
    );
    expect(screen).toContain('verifiedOccurrenceRepairConfirmMessage');
    expect(screen).toContain('verifiedOccurrenceRepairVerificationFailureMessage');
    expect(screen).toContain('verifiedOccurrenceRepairCloudRequestFailureMessage');
    expect(screen).not.toContain('delete duplicates');
    expect(screen).not.toContain('assignment failed');
    const verificationMessage = verifiedOccurrenceRepairVerificationFailureMessage();
    const cloudMessage = verifiedOccurrenceRepairCloudRequestFailureMessage();
    expect(verificationMessage).toContain('already committed');
    expect(verificationMessage).toContain('not rolled back');
    expect(cloudMessage).toContain('Local assignment succeeded');
    expect(cloudMessage).toContain('Cloud sync request failed');
    expect(cloudMessage).not.toContain('assignment failed');
    expect(verificationMessage).not.toContain('assignment failed');
    expect(operator).toContain('assignVerifiedPurchaseOccurrenceWithDb');
    expect(operator).toContain('dryRunVerifiedPurchaseOccurrenceRepairWithDb');
    expect(operator).toContain('requestCloudBackupFlush');
    expect(operator).not.toMatch(/\bUPDATE\s+receipts\b/i);
    expect(operator).not.toContain('getSupabaseClient');
    expect(operator).not.toContain('as never');
    const assignCall = operator.slice(
      operator.indexOf('const assigned = await assign'),
      operator.indexOf('const verification = await capturePostAssignmentVerification')
    );
    expect(assignCall).toContain('source: VERIFIED_OCCURRENCE_REPAIR_SOURCE');
    expect(assignCall).not.toContain('occurrenceId');
  });
});
