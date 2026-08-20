/**
 * P0 Phase 4 — local ownership stamp context (no cloud, no db import).
 * Keeps db.ts decoupled from auth bootstrap internals.
 */
import { getAuthState } from './anonAuth';
import { getOrCreateInstallationId } from './installationId';

export const TRANSACTION_SOURCE_RECEIPT_OCR = 'receipt_ocr' as const;

export type TransactionSource = typeof TRANSACTION_SOURCE_RECEIPT_OCR | 'manual' | 'import' | 'shared' | 'other';

export type LocalOwnershipStamp = {
  userId: string | null;
  installationId: string | null;
  transactionSource: typeof TRANSACTION_SOURCE_RECEIPT_OCR;
};

export type OwnershipStampProvider = () => Promise<LocalOwnershipStamp>;

async function defaultOwnershipStampProvider(): Promise<LocalOwnershipStamp> {
  const auth = getAuthState();
  const userId =
    auth.status === 'authenticated' && typeof auth.userId === 'string' && auth.userId.trim()
      ? auth.userId.trim()
      : null;

  let installationId: string | null = null;
  try {
    installationId = await getOrCreateInstallationId();
  } catch (e) {
    console.warn('[Ownership] installation_id unavailable (nonfatal):', e);
  }

  return {
    userId,
    installationId,
    transactionSource: TRANSACTION_SOURCE_RECEIPT_OCR,
  };
}

let _provider: OwnershipStampProvider = defaultOwnershipStampProvider;

/** Resolve ownership fields for a new local receipt save. Never throws. */
export async function resolveOwnershipStamp(): Promise<LocalOwnershipStamp> {
  try {
    return await _provider();
  } catch (e) {
    console.warn('[Ownership] stamp provider failed (nonfatal):', e);
    return {
      userId: null,
      installationId: null,
      transactionSource: TRANSACTION_SOURCE_RECEIPT_OCR,
    };
  }
}

/** Test-only provider override. */
export function __setOwnershipStampProviderForTests(provider: OwnershipStampProvider | null): void {
  _provider = provider ?? defaultOwnershipStampProvider;
}
