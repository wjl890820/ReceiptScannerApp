/**
 * PRE-C2D — cold-start owner-scope readiness (auth initializing truth).
 */
/* eslint-disable import/first -- Jest mocks must run before imports. */

import type { OwnershipAdoptionSettleResult } from './ownershipAdoptionOrchestrator';

const mockEnsureAnonAuth = jest.fn();
const mockGetAuthState = jest.fn();
const mockIsAnonAuthEnabled = jest.fn(() => true);
const mockAdoptionSettle = jest.fn(
  async (): Promise<OwnershipAdoptionSettleResult> => ({
    status: 'settled',
    reason: 'noop',
    userId: 'user-U',
  })
);
const mockRecordDiagnosticEvent = jest.fn();
const mockResolveOwnershipStamp = jest.fn();

jest.mock('./anonAuth', () => ({
  ensureAnonAuth: mockEnsureAnonAuth,
  getAuthState: mockGetAuthState,
}));

jest.mock('./env', () => ({
  isAnonAuthEnabled: () => mockIsAnonAuthEnabled(),
}));

jest.mock('./ownershipAdoptionOrchestrator', () => ({
  ensureOwnershipAdoptionSettledForOwnerRead: mockAdoptionSettle,
  settleOwnershipAdoptionForCurrentAuth: mockAdoptionSettle,
}));

jest.mock('./internalDiagnostics', () => ({
  recordDiagnosticEvent: mockRecordDiagnosticEvent,
}));

jest.mock('./receiptOwnershipContext', () => ({
  resolveOwnershipStamp: mockResolveOwnershipStamp,
  __setOwnershipStampProviderForTests: jest.fn(),
  TRANSACTION_SOURCE_RECEIPT_OCR: 'receipt_ocr',
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import type { AuthState } from './anonAuth';
import {
  ensureAuthoritativeOwnerScopeReady,
  recordOwnerScopeWaitEnd,
} from './ownerScopeReadiness';
import { resolveCurrentLocalReceiptOwnerScope } from './receiptOwnershipScope';

function auth(partial: Partial<AuthState> & Pick<AuthState, 'status'>): AuthState {
  return {
    userId: null,
    isAnonymous: null,
    hasAppleIdentity: null,
    accessToken: null,
    error: null,
    ...partial,
  };
}

describe('owner-scope cold-start readiness', () => {
  beforeEach(() => {
    mockEnsureAnonAuth.mockReset();
    mockGetAuthState.mockReset();
    mockIsAnonAuthEnabled.mockReset();
    mockIsAnonAuthEnabled.mockReturnValue(true);
    mockAdoptionSettle.mockReset();
    mockAdoptionSettle.mockImplementation(async () => {
      const state = mockGetAuthState() as AuthState | undefined;
      return {
        status: 'settled' as const,
        reason: 'noop' as const,
        userId: state?.userId || 'user-U',
      };
    });
    mockRecordDiagnosticEvent.mockReset();
    mockResolveOwnershipStamp.mockReset();
  });

  it('A — initializing waits for auth then resolves user scope', async () => {
    let status: AuthState['status'] = 'initializing';
    mockGetAuthState.mockImplementation(() =>
      auth({
        status,
        userId: status === 'authenticated' ? 'user-U' : null,
        isAnonymous: status === 'authenticated' ? true : null,
      })
    );
    mockEnsureAnonAuth.mockImplementation(async () => {
      status = 'authenticated';
      return auth({
        status: 'authenticated',
        userId: 'user-U',
        isAnonymous: true,
      });
    });
    mockResolveOwnershipStamp.mockImplementation(async () => ({
      userId: status === 'authenticated' ? 'user-U' : null,
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    }));

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(mockEnsureAnonAuth).toHaveBeenCalledTimes(1);
    expect(mockAdoptionSettle).toHaveBeenCalled();
    expect(scope).toEqual({
      status: 'ready',
      ownerKey: 'user:user-U',
      receiptWhereSql: 'receipts.user_id = ?',
      itemWhereSql: 'receipts.user_id = ?',
      params: ['user-U'],
    });
  });

  it('B — already authenticated fast path', async () => {
    mockGetAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'user-fast', isAnonymous: true })
    );
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-fast',
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    });
    await resolveCurrentLocalReceiptOwnerScope();
    expect(mockEnsureAnonAuth).not.toHaveBeenCalled();
  });

  it('C — auth disabled → installation scope without auth/adoption wait', async () => {
    mockIsAnonAuthEnabled.mockReturnValue(false);
    mockGetAuthState.mockReturnValue(auth({ status: 'initializing' }));
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'should-ignore',
      installationId: 'install-disabled',
      transactionSource: 'receipt_ocr',
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(mockEnsureAnonAuth).not.toHaveBeenCalled();
    expect(mockAdoptionSettle).not.toHaveBeenCalled();
    expect(scope).toMatchObject({
      status: 'ready',
      ownerKey: 'installation:install-disabled',
    });
  });

  it('D — unavailable/offline uses installation scope', async () => {
    let status: AuthState['status'] = 'initializing';
    mockGetAuthState.mockImplementation(() => auth({ status, userId: null }));
    mockEnsureAnonAuth.mockImplementation(async () => {
      status = 'unavailable';
      return auth({ status: 'unavailable', userId: null, error: 'offline' });
    });
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: null,
      installationId: 'install-local',
      transactionSource: 'receipt_ocr',
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope).toMatchObject({
      status: 'ready',
      ownerKey: 'installation:install-local',
    });
  });

  it('E — genuine empty authenticated user scope is valid', async () => {
    mockGetAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'user-empty', isAnonymous: true })
    );
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-empty',
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    });
    const readiness = await ensureAuthoritativeOwnerScopeReady();
    expect(readiness.waitedForAuth).toBe(false);
    expect(readiness.blockAuthoritativeUserScope).toBe(false);
    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope).toMatchObject({ status: 'ready', ownerKey: 'user:user-empty' });
  });

  it('H — adoption failure → owner_unavailable (not user empty)', async () => {
    mockGetAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'user-U', isAnonymous: true })
    );
    mockAdoptionSettle.mockResolvedValue({
      status: 'failed',
      reason: 'boom',
      userId: 'user-U',
    });
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-U',
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    });
    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope).toEqual({
      status: 'owner_unavailable',
      reason: 'adoption_failed',
    });
    expect(mockResolveOwnershipStamp).not.toHaveBeenCalled();
  });

  it('J — adoption not_ready/db_unavailable → owner_unavailable', async () => {
    mockGetAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'user-U', isAnonymous: true })
    );
    mockAdoptionSettle.mockResolvedValue({
      status: 'not_ready',
      reason: 'db_unavailable',
      userId: 'user-U',
    });
    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope).toEqual({
      status: 'owner_unavailable',
      reason: 'adoption_not_ready',
    });
  });

  it('L — auth U→V during async stamp → never returns stale U', async () => {
    let authUser: string | null = 'user-U';
    let authStatus: AuthState['status'] = 'authenticated';
    mockGetAuthState.mockImplementation(() =>
      auth({
        status: authStatus,
        userId: authUser,
        isAnonymous: true,
      })
    );
    mockResolveOwnershipStamp.mockImplementation(async () => {
      // Capture candidate U, then auth flips to V before resume.
      const captured = authUser;
      authUser = 'user-V';
      await Promise.resolve();
      return {
        userId: captured,
        installationId: 'install-1',
        transactionSource: 'receipt_ocr',
      };
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    if (scope.status === 'ready') {
      expect(scope.ownerKey).not.toBe('user:user-U');
      expect(scope.ownerKey === 'user:user-V' || scope.ownerKey.startsWith('installation:')).toBe(
        true
      );
    } else {
      expect(scope.status).toBe('owner_unavailable');
    }
  });

  it('M — auth U→unavailable during async stamp → never returns stale U', async () => {
    let authStatus: AuthState['status'] = 'authenticated';
    let authUser: string | null = 'user-U';
    mockGetAuthState.mockImplementation(() =>
      auth({ status: authStatus, userId: authUser, isAnonymous: true })
    );
    mockResolveOwnershipStamp.mockImplementation(async () => {
      authStatus = 'unavailable';
      authUser = null;
      await Promise.resolve();
      return {
        userId: 'user-U',
        installationId: 'install-1',
        transactionSource: 'receipt_ocr',
      };
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope.status === 'ready' ? scope.ownerKey : 'unavailable').not.toBe(
      'user:user-U'
    );
    if (scope.status === 'ready') {
      expect(scope.ownerKey).toBe('installation:install-1');
    }
  });

  it('N — owner isolation: user predicates never OR installation', async () => {
    mockGetAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'user-A', isAnonymous: true })
    );
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-A',
      installationId: 'install-shared',
      transactionSource: 'receipt_ocr',
    });
    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope.status).toBe('ready');
    if (scope.status === 'ready') {
      expect(scope.receiptWhereSql).toBe('receipts.user_id = ?');
      expect(scope.receiptWhereSql).not.toMatch(/\bOR\b/i);
    }
  });

  it('P — ANALYSIS_PRICE_CHANGES gate remains fail-closed by default', () => {
    const analysis = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(analysis).toContain('isAnalysisPriceChangesEnabled');
    expect(analysis).not.toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
    const eas = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../eas.json'), 'utf8')
    );
    expect(eas.build.production.env?.ENABLE_ANALYSIS_PRICE_CHANGES).toBe(
      'false'
    );
  });

  it('Q — not_applicable → anonymous V during stamp must not reuse not_applicable', async () => {
    let authStatus: AuthState['status'] = 'unavailable';
    let authUser: string | null = null;
    let authAnon: boolean | null = null;
    let firstStampSeen = false;
    const settleResults: OwnershipAdoptionSettleResult[] = [];

    mockGetAuthState.mockImplementation(() =>
      auth({
        status: authStatus,
        userId: authUser,
        isAnonymous: authAnon,
      })
    );
    mockAdoptionSettle.mockImplementation(async () => {
      const state = mockGetAuthState() as AuthState;
      let result: OwnershipAdoptionSettleResult;
      if (
        state.status === 'authenticated' &&
        state.isAnonymous === true &&
        typeof state.userId === 'string' &&
        state.userId.trim()
      ) {
        result = {
          status: 'settled',
          reason: 'noop',
          userId: state.userId.trim(),
        };
      } else {
        result = { status: 'not_applicable' };
      }
      settleResults.push(result);
      return result;
    });
    mockResolveOwnershipStamp.mockImplementation(async () => {
      // First deferred stamp: flip to authenticated anonymous V.
      if (!firstStampSeen) {
        firstStampSeen = true;
        authStatus = 'authenticated';
        authUser = 'user-V';
        authAnon = true;
        await Promise.resolve();
      }
      return {
        userId: authUser,
        installationId: 'install-1',
        transactionSource: 'receipt_ocr',
      };
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    // Original not_applicable must never authorize user:V by itself.
    expect(settleResults[0]?.status).toBe('not_applicable');
    if (scope.status === 'ready') {
      expect(scope.ownerKey).toBe('user:user-V');
      // Bounded retry must have run V-specific settlement.
      expect(settleResults.some((r) => r.status === 'settled')).toBe(true);
      expect(mockAdoptionSettle.mock.calls.length).toBeGreaterThanOrEqual(2);
    } else {
      expect(scope.status).toBe('owner_unavailable');
    }
  });

  it('R — final non-anonymous N + not_applicable → user:N allowed', async () => {
    mockGetAuthState.mockReturnValue(
      auth({
        status: 'authenticated',
        userId: 'user-N',
        isAnonymous: false,
      })
    );
    mockAdoptionSettle.mockResolvedValue({ status: 'not_applicable' });
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-N',
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope).toEqual({
      status: 'ready',
      ownerKey: 'user:user-N',
      receiptWhereSql: 'receipts.user_id = ?',
      itemWhereSql: 'receipts.user_id = ?',
      params: ['user-N'],
    });
  });

  it('S — final anonymous A + not_applicable → not authorized', async () => {
    mockGetAuthState.mockReturnValue(
      auth({
        status: 'authenticated',
        userId: 'user-A',
        isAnonymous: true,
      })
    );
    mockAdoptionSettle.mockResolvedValue({ status: 'not_applicable' });
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-A',
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope).toEqual({
      status: 'owner_unavailable',
      reason: 'auth_unstable',
    });
    // Bounded full-cycle retry once (attempt 0 + attempt 1).
    expect(mockAdoptionSettle.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('T — authenticated isAnonymous=null → not_applicable does not authorize', async () => {
    mockGetAuthState.mockReturnValue(
      auth({
        status: 'authenticated',
        userId: 'user-A',
        isAnonymous: null,
      })
    );
    mockAdoptionSettle.mockResolvedValue({ status: 'not_applicable' });
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-A',
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    });

    const scope = await resolveCurrentLocalReceiptOwnerScope();
    expect(scope).toEqual({
      status: 'owner_unavailable',
      reason: 'auth_unstable',
    });
    expect(mockAdoptionSettle.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('records safe owner_scope_wait diagnostics without ids', async () => {
    let status: AuthState['status'] = 'initializing';
    mockGetAuthState.mockImplementation(() =>
      auth({
        status,
        userId: status === 'authenticated' ? 'user-U' : null,
        isAnonymous: true,
      })
    );
    mockEnsureAnonAuth.mockImplementation(async () => {
      status = 'authenticated';
      return auth({ status: 'authenticated', userId: 'user-U', isAnonymous: true });
    });
    mockResolveOwnershipStamp.mockResolvedValue({
      userId: 'user-U',
      installationId: 'install-1',
      transactionSource: 'receipt_ocr',
    });

    await resolveCurrentLocalReceiptOwnerScope();
    const names = mockRecordDiagnosticEvent.mock.calls.map((c) => c[0]?.name);
    expect(names).toContain('owner_scope_wait_begin');
    expect(names).toContain('owner_scope_wait_end');
    const payload = JSON.stringify(mockRecordDiagnosticEvent.mock.calls);
    expect(payload).not.toContain('user-U');
    expect(payload).not.toContain('install-1');
  });

  it('recordOwnerScopeWaitEnd no-ops when auth was not waited', () => {
    recordOwnerScopeWaitEnd(
      {
        waitedForAuth: false,
        authStatusBefore: 'authenticated',
        authStatusAfter: 'authenticated',
        waitStartedAtMs: null,
        adoption: { status: 'not_applicable' },
        adoptionUserId: null,
        blockAuthoritativeUserScope: false,
      },
      'user'
    );
    expect(mockRecordDiagnosticEvent).not.toHaveBeenCalled();
  });
});
