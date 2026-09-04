/**
 * Final owner-truth hardening — adoption settle discrimination + concurrency.
 */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;

const mockAdoptWithDefaults = jest.fn();
jest.mock('./legacyReceiptAdoption', () => {
  const actual = jest.requireActual('./legacyReceiptAdoption');
  return {
    ...actual,
    adoptUnownedReceiptsForUserWithDefaults: (...args: unknown[]) =>
      mockAdoptWithDefaults(...args),
  };
});

jest.mock('./anonAuth', () => ({
  getAuthState: jest.fn(),
  subscribeAuthState: jest.fn(() => jest.fn()),
}));

jest.mock('./cloudBackupBootstrap', () => ({
  enqueueUpsertIntentsForReceiptIds: jest.fn(async () => undefined),
}));

jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => undefined),
}));

jest.mock('./env', () => ({
  isAnonAuthEnabled: () => true,
}));

import { getAuthState, subscribeAuthState, type AuthState } from './anonAuth';
import {
  __getAdoptionInFlightUserIdForTests,
  __isAdoptionSettledForUserForTests,
  __resetOwnershipAdoptionOrchestratorForTests,
  ensureOwnershipAdoptionSettledForOwnerRead,
  settleOwnershipAdoptionForCurrentAuth,
  startOwnershipAdoptionOrchestrator,
} from './ownershipAdoptionOrchestrator';

const mockGetAuthState = getAuthState as jest.MockedFunction<typeof getAuthState>;
const mockSubscribeAuthState = subscribeAuthState as jest.MockedFunction<
  typeof subscribeAuthState
>;

function authState(
  overrides: Partial<AuthState> & {
    status: AuthState['status'];
    userId: string | null;
    isAnonymous: boolean | null;
  }
): AuthState {
  return {
    hasAppleIdentity: false,
    accessToken: null,
    error: null,
    ...overrides,
  };
}

describe('ownership adoption settle discrimination', () => {
  beforeEach(() => {
    mockAdoptWithDefaults.mockReset();
  });

  afterEach(() => {
    __resetOwnershipAdoptionOrchestratorForTests();
    mockAdoptWithDefaults.mockReset();
  });

  it('G — successful zero-row no-op is settled', async () => {
    mockAdoptWithDefaults.mockResolvedValue({
      adopted: 0,
      adopted_receipt_ids: [],
      already_owned_by_current_user: 0,
      owned_by_other_user: 0,
      eligible_current_install_unowned: 0,
      remaining_eligible_current_install_unowned: 0,
      ambiguous_double_null: 0,
      other_install_unowned: 0,
      remaining_unowned: 0,
    });
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'unavailable',
        userId: null,
        isAnonymous: null,
      })
    );
    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'anon-noop',
        isAnonymous: true,
      })
    );

    const result = await ensureOwnershipAdoptionSettledForOwnerRead();
    expect(result).toEqual({
      status: 'settled',
      reason: 'noop',
      userId: 'anon-noop',
    });
    expect(__isAdoptionSettledForUserForTests('anon-noop')).toBe(true);
  });

  it('F — successful adopt >0 is settled with adopted reason', async () => {
    mockAdoptWithDefaults.mockResolvedValue({
      adopted: 2,
      adopted_receipt_ids: ['A', 'B'],
      already_owned_by_current_user: 0,
      owned_by_other_user: 0,
      eligible_current_install_unowned: 2,
      remaining_eligible_current_install_unowned: 0,
      ambiguous_double_null: 0,
      other_install_unowned: 0,
      remaining_unowned: 0,
    });
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'unavailable',
        userId: null,
        isAnonymous: null,
      })
    );
    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'anon-adopt',
        isAnonymous: true,
      })
    );

    const result = await ensureOwnershipAdoptionSettledForOwnerRead();
    expect(result).toEqual({
      status: 'settled',
      reason: 'adopted',
      userId: 'anon-adopt',
    });
    expect(__isAdoptionSettledForUserForTests('anon-adopt')).toBe(true);
  });

  it('H — adoption exception is failed and NOT settled', async () => {
    mockAdoptWithDefaults.mockRejectedValue(new Error('adopt boom'));
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'unavailable',
        userId: null,
        isAnonymous: null,
      })
    );
    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'anon-fail',
        isAnonymous: true,
      })
    );

    const result = await ensureOwnershipAdoptionSettledForOwnerRead();
    expect(result.status).toBe('failed');
    expect(__isAdoptionSettledForUserForTests('anon-fail')).toBe(false);
  });

  it('I — retry after failed adoption can later succeed', async () => {
    mockAdoptWithDefaults
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce({
        adopted: 1,
        adopted_receipt_ids: ['R1'],
        already_owned_by_current_user: 0,
        owned_by_other_user: 0,
        eligible_current_install_unowned: 1,
        remaining_eligible_current_install_unowned: 0,
        ambiguous_double_null: 0,
        other_install_unowned: 0,
        remaining_unowned: 0,
      });
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'unavailable',
        userId: null,
        isAnonymous: null,
      })
    );
    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'anon-retry',
        isAnonymous: true,
      })
    );

    const first = await ensureOwnershipAdoptionSettledForOwnerRead();
    expect(first.status).toBe('failed');
    expect(__isAdoptionSettledForUserForTests('anon-retry')).toBe(false);

    const second = await ensureOwnershipAdoptionSettledForOwnerRead();
    expect(second).toEqual({
      status: 'settled',
      reason: 'adopted',
      userId: 'anon-retry',
    });
    expect(__isAdoptionSettledForUserForTests('anon-retry')).toBe(true);
  });

  it('J — _getDb unavailable → not_ready and NOT settled', async () => {
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'anon-nodb',
        isAnonymous: true,
      })
    );
    // Do not start orchestrator — _getDb remains null.
    const result = await ensureOwnershipAdoptionSettledForOwnerRead();
    expect(result).toEqual({
      status: 'not_ready',
      reason: 'db_unavailable',
      userId: 'anon-nodb',
    });
    expect(__isAdoptionSettledForUserForTests('anon-nodb')).toBe(false);
    expect(mockAdoptWithDefaults).not.toHaveBeenCalled();
  });

  it('K — orchestrator + readiness share one adoption (success)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockAdoptWithDefaults.mockImplementation(async () => {
      await gate;
      return {
        adopted: 1,
        adopted_receipt_ids: ['X'],
        already_owned_by_current_user: 0,
        owned_by_other_user: 0,
        eligible_current_install_unowned: 1,
        remaining_eligible_current_install_unowned: 0,
        ambiguous_double_null: 0,
        other_install_unowned: 0,
        remaining_unowned: 0,
      };
    });
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'anon-share',
        isAnonymous: true,
      })
    );

    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    const listener = mockSubscribeAuthState.mock.calls[0][0];
    const orch = listener(
      authState({
        status: 'authenticated',
        userId: 'anon-share',
        isAnonymous: true,
      })
    );
    const readiness = ensureOwnershipAdoptionSettledForOwnerRead();
    release();
    await orch;
    const readinessResult = await readiness;
    expect(mockAdoptWithDefaults).toHaveBeenCalledTimes(1);
    expect(readinessResult).toEqual({
      status: 'settled',
      reason: 'adopted',
      userId: 'anon-share',
    });
  });

  it('K2 — orchestrator + readiness share one adoption (failure)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockAdoptWithDefaults.mockImplementation(async () => {
      await gate;
      throw new Error('shared fail');
    });
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'anon-share-fail',
        isAnonymous: true,
      })
    );

    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    const listener = mockSubscribeAuthState.mock.calls[0][0];
    const orch = listener(
      authState({
        status: 'authenticated',
        userId: 'anon-share-fail',
        isAnonymous: true,
      })
    );
    const readiness = settleOwnershipAdoptionForCurrentAuth();
    release();
    await orch;
    const readinessResult = await readiness;
    expect(mockAdoptWithDefaults).toHaveBeenCalledTimes(1);
    expect(readinessResult.status).toBe('failed');
    expect(__isAdoptionSettledForUserForTests('anon-share-fail')).toBe(false);
  });

  it('B — U in-flight then V readiness does not reuse U result', async () => {
    let releaseU!: () => void;
    const gateU = new Promise<void>((r) => {
      releaseU = r;
    });
    const adoptCalls: string[] = [];
    mockAdoptWithDefaults.mockImplementation(async (userId: string) => {
      adoptCalls.push(userId);
      if (userId === 'user-U') {
        await gateU;
      }
      return {
        adopted: 0,
        adopted_receipt_ids: [],
        already_owned_by_current_user: 0,
        owned_by_other_user: 0,
        eligible_current_install_unowned: 0,
        remaining_eligible_current_install_unowned: 0,
        ambiguous_double_null: 0,
        other_install_unowned: 0,
        remaining_unowned: 0,
      };
    });

    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'user-U',
        isAnonymous: true,
      })
    );
    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    const uPromise = settleOwnershipAdoptionForCurrentAuth();
    expect(__getAdoptionInFlightUserIdForTests()).toBe('user-U');

    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'user-V',
        isAnonymous: true,
      })
    );
    const vPromise = settleOwnershipAdoptionForCurrentAuth();
    releaseU();
    const [uResult, vResult] = await Promise.all([uPromise, vPromise]);
    // Auth flipped to V while U's adoption ran → U fails closed (auth_mismatch).
    expect(uResult).toEqual({
      status: 'failed',
      reason: 'auth_mismatch',
      userId: 'user-U',
    });
    expect(vResult).toEqual({
      status: 'settled',
      reason: 'noop',
      userId: 'user-V',
    });
    expect(adoptCalls).toEqual(['user-U', 'user-V']);
    expect(__isAdoptionSettledForUserForTests('user-U')).toBe(false);
    expect(__isAdoptionSettledForUserForTests('user-V')).toBe(true);
  });

  it('O — adoption does not re-enter owner-scope resolution (no deadlock import)', async () => {
    // Structural: settle path uses legacyReceiptAdoption + getDb only.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'ownershipAdoptionOrchestrator.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/resolveCurrentLocalReceiptOwnerScope/);
    expect(source).not.toMatch(/ownerScopeReadiness/);
    expect(source).not.toMatch(/listReceipts/);
  });
});
