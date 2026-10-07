/**
 * Observational receipt-owner lookup — no auth bootstrap, adoption, or id creation.
 */

/* eslint-disable import/first */
const ensureAnonAuth = jest.fn(async () => {
  throw new Error('anon auth bootstrap');
});
const settleAdoption = jest.fn(async () => {
  throw new Error('ownership adoption');
});
const setInstallationId = jest.fn(async (_key: string, _value: string) => {
  throw new Error('installation id create');
});
const getInstallationId = jest.fn(async () => null as string | null);
const getAuthState = jest.fn();
const isAnonAuthEnabled = jest.fn(() => true);
const readSettledOwnershipAdoptionUserId = jest.fn(() => null as string | null);

jest.mock('./anonAuth', () => ({
  getAuthState: () => getAuthState(),
  ensureAnonAuth: () => ensureAnonAuth(),
}));

jest.mock('./env', () => ({
  isAnonAuthEnabled: () => isAnonAuthEnabled(),
}));

jest.mock('./ownershipAdoptionOrchestrator', () => ({
  readSettledOwnershipAdoptionUserId: () => readSettledOwnershipAdoptionUserId(),
  settleOwnershipAdoptionForCurrentAuth: () => settleAdoption(),
  ensureOwnershipAdoptionSettledForOwnerRead: () => settleAdoption(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: () => getInstallationId(),
  setItem: (key: string, value: string) => setInstallationId(key, value),
}));

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

import { resolveObservationalReceiptOwnerScope } from './observationalReceiptOwnerScope';

function auth(partial: {
  status: 'initializing' | 'authenticated' | 'unavailable';
  userId?: string | null;
  isAnonymous?: boolean | null;
}) {
  return {
    status: partial.status,
    userId: partial.userId ?? null,
    isAnonymous: partial.isAnonymous ?? null,
    hasAppleIdentity: null,
    accessToken: null,
    error: null,
  };
}

describe('observational receipt owner scope', () => {
  beforeEach(() => {
    ensureAnonAuth.mockClear();
    settleAdoption.mockClear();
    setInstallationId.mockClear();
    getInstallationId.mockReset();
    getInstallationId.mockResolvedValue(null);
    getAuthState.mockReset();
    isAnonAuthEnabled.mockReturnValue(true);
    readSettledOwnershipAdoptionUserId.mockReturnValue(null);
  });

  it('uses an already authenticated non-anonymous user without bootstrap', async () => {
    getAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'apple-user', isAnonymous: false })
    );
    const scope = await resolveObservationalReceiptOwnerScope();
    expect(scope).toMatchObject({
      status: 'ready',
      ownerKey: 'user:apple-user',
      params: ['apple-user'],
    });
    expect(ensureAnonAuth).not.toHaveBeenCalled();
    expect(settleAdoption).not.toHaveBeenCalled();
    expect(setInstallationId).not.toHaveBeenCalled();
    expect(getInstallationId).not.toHaveBeenCalled();
  });

  it('uses anonymous user scope only when adoption is already settled', async () => {
    getAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'anon-user', isAnonymous: true })
    );
    await expect(resolveObservationalReceiptOwnerScope()).resolves.toEqual({
      status: 'owner_unavailable',
    });
    expect(settleAdoption).not.toHaveBeenCalled();
    expect(ensureAnonAuth).not.toHaveBeenCalled();

    readSettledOwnershipAdoptionUserId.mockReturnValue('anon-user');
    const scope = await resolveObservationalReceiptOwnerScope();
    expect(scope).toMatchObject({ status: 'ready', ownerKey: 'user:anon-user' });
    expect(settleAdoption).not.toHaveBeenCalled();
  });

  it('fails closed while auth is initializing', async () => {
    getAuthState.mockReturnValue(auth({ status: 'initializing' }));
    getInstallationId.mockResolvedValue('already-stored');
    await expect(resolveObservationalReceiptOwnerScope()).resolves.toEqual({
      status: 'owner_unavailable',
    });
    expect(ensureAnonAuth).not.toHaveBeenCalled();
    expect(setInstallationId).not.toHaveBeenCalled();
  });

  it('reads a stored installation id and does not create one', async () => {
    getAuthState.mockReturnValue(auth({ status: 'unavailable' }));
    await expect(resolveObservationalReceiptOwnerScope()).resolves.toEqual({
      status: 'owner_unavailable',
    });
    expect(setInstallationId).not.toHaveBeenCalled();

    getInstallationId.mockResolvedValue(' install-1 ');
    const scope = await resolveObservationalReceiptOwnerScope();
    expect(scope).toMatchObject({
      status: 'ready',
      ownerKey: 'installation:install-1',
      params: ['install-1'],
    });
    expect(setInstallationId).not.toHaveBeenCalled();
    expect(ensureAnonAuth).not.toHaveBeenCalled();
    expect(settleAdoption).not.toHaveBeenCalled();
  });

  it('fails closed when isAnonymous is unknown', async () => {
    getAuthState.mockReturnValue(
      auth({ status: 'authenticated', userId: 'user-x', isAnonymous: null })
    );
    await expect(resolveObservationalReceiptOwnerScope()).resolves.toEqual({
      status: 'owner_unavailable',
    });
    expect(ensureAnonAuth).not.toHaveBeenCalled();
    expect(settleAdoption).not.toHaveBeenCalled();
  });
});
