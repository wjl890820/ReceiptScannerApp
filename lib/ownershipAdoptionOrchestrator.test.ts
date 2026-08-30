/**
 * Privacy-H5 — ownership adoption orchestrator tests.
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
import { enqueueUpsertIntentsForReceiptIds } from './cloudBackupBootstrap';
import {
  __resetOwnershipAdoptionOrchestratorForTests,
  startOwnershipAdoptionOrchestrator,
} from './ownershipAdoptionOrchestrator';

const mockGetAuthState = getAuthState as jest.MockedFunction<typeof getAuthState>;
const mockSubscribeAuthState = subscribeAuthState as jest.MockedFunction<
  typeof subscribeAuthState
>;
const mockEnqueue = enqueueUpsertIntentsForReceiptIds as jest.MockedFunction<
  typeof enqueueUpsertIntentsForReceiptIds
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

describe('ownershipAdoptionOrchestrator', () => {
  beforeEach(() => {
    mockAdoptWithDefaults.mockReset();
  });

  afterEach(() => {
    __resetOwnershipAdoptionOrchestratorForTests();
    mockEnqueue.mockClear();
    mockAdoptWithDefaults.mockReset();
  });

  it('does not auto-adopt for non-anonymous authenticated users', async () => {
    mockGetAuthState.mockReturnValue(
      authState({
        status: 'authenticated',
        userId: 'apple-user',
        isAnonymous: false,
      })
    );

    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    const listener = mockSubscribeAuthState.mock.calls[0][0];
    await listener(
      authState({
        status: 'authenticated',
        userId: 'apple-user',
        isAnonymous: false,
      })
    );

    expect(mockAdoptWithDefaults).not.toHaveBeenCalled();
  });

  it('hands off only proven adopted IDs for anonymous user', async () => {
    mockAdoptWithDefaults.mockResolvedValue({
      adopted: 1,
      adopted_receipt_ids: ['A'],
      already_owned_by_current_user: 0,
      owned_by_other_user: 0,
      eligible_current_install_unowned: 0,
      remaining_eligible_current_install_unowned: 0,
      ambiguous_double_null: 0,
      other_install_unowned: 0,
      remaining_unowned: 0,
    });
    const db = { marker: 'db' };

    mockGetAuthState.mockImplementation(() =>
      authState({
        status: 'authenticated',
        userId: 'anon-u1',
        isAnonymous: true,
      })
    );

    startOwnershipAdoptionOrchestrator(async () => db as any);
    const listener = mockSubscribeAuthState.mock.calls[0][0];
    await listener(
      authState({
        status: 'authenticated',
        userId: 'anon-u1',
        isAnonymous: true,
      })
    );

    expect(mockAdoptWithDefaults).toHaveBeenCalledWith(
      'anon-u1',
      expect.any(Function),
      expect.objectContaining({
        authEligibility: expect.objectContaining({
          isValid: expect.any(Function),
        }),
      })
    );
  });

  it('does not enqueue backup when auth changes before handoff', async () => {
    mockAdoptWithDefaults.mockResolvedValue({
      adopted: 1,
      adopted_receipt_ids: ['A'],
      already_owned_by_current_user: 0,
      owned_by_other_user: 0,
      eligible_current_install_unowned: 0,
      remaining_eligible_current_install_unowned: 0,
      ambiguous_double_null: 0,
      other_install_unowned: 0,
      remaining_unowned: 0,
    });

    mockGetAuthState.mockImplementation(() =>
      authState({
        status: 'authenticated',
        userId: 'anon-u2',
        isAnonymous: true,
      })
    );

    startOwnershipAdoptionOrchestrator(async () => ({}) as any);
    const listener = mockSubscribeAuthState.mock.calls[0][0];
    await listener(
      authState({
        status: 'authenticated',
        userId: 'anon-u1',
        isAnonymous: true,
      })
    );

    expect(mockAdoptWithDefaults).toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
