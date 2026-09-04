/**
 * Typed transient failure for owner-scoped receipt reads.
 * Distinguishes unavailable owner truth from a stable authoritative empty query.
 * Contains no userId / installationId / tokens.
 */

export type OwnerScopedReceiptReadUnavailableReason =
  | 'adoption_failed'
  | 'adoption_not_ready'
  | 'auth_unstable'
  | 'owner_unavailable';

export const OWNER_SCOPE_UNAVAILABLE_CODE = 'OWNER_SCOPE_UNAVAILABLE' as const;

export class OwnerScopedReceiptReadUnavailableError extends Error {
  readonly code = OWNER_SCOPE_UNAVAILABLE_CODE;
  readonly reason: OwnerScopedReceiptReadUnavailableReason;

  constructor(
    reason: OwnerScopedReceiptReadUnavailableReason = 'owner_unavailable'
  ) {
    super(`Owner-scoped receipt read unavailable (${reason})`);
    this.name = 'OwnerScopedReceiptReadUnavailableError';
    this.reason = reason;
  }
}

export function isOwnerScopedReceiptReadUnavailableError(
  value: unknown
): value is OwnerScopedReceiptReadUnavailableError {
  return (
    value instanceof OwnerScopedReceiptReadUnavailableError ||
    (typeof value === 'object' &&
      value != null &&
      (value as { code?: unknown }).code === OWNER_SCOPE_UNAVAILABLE_CODE)
  );
}

export function throwIfOwnerScopeUnavailable(
  scope: { status: string },
  reason: OwnerScopedReceiptReadUnavailableReason = 'owner_unavailable'
): asserts scope is { status: 'ready' } {
  if (scope.status !== 'ready') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordDiagnosticEvent } = require('./internalDiagnostics') as {
        recordDiagnosticEvent: (args: {
          category: 'lifecycle';
          name: string;
          screen: string;
          meta?: Record<string, unknown>;
        }) => void;
      };
      recordDiagnosticEvent({
        category: 'lifecycle',
        name: 'owner_scope_unavailable',
        screen: 'owner_scope',
        meta: { reason },
      });
    } catch {
      // never block throw
    }
    throw new OwnerScopedReceiptReadUnavailableError(reason);
  }
}
