/**
 * Process-local barrier for the current-user clean-local restore attempt.
 * No network, no auth, and no SQLite. Callers decide when to arm it.
 */

export class CurrentUserRestoreBlockedError extends Error {
  readonly code = 'current_user_restore_blocked';

  constructor() {
    super('Cloud restore must finish before this change can be saved.');
    this.name = 'CurrentUserRestoreBlockedError';
  }
}

export type CurrentUserRestorePhase = 'unarmed' | 'pending' | 'settled' | 'failed';

let phase: CurrentUserRestorePhase = 'unarmed';
let pending: Promise<void> = Promise.resolve();
let releasePending: (() => void) | null = null;
let accountSwitchDepth = 0;

export function currentUserRestorePhase(): CurrentUserRestorePhase {
  return phase;
}

export function armCurrentUserRestoreBarrier(): void {
  phase = 'pending';
  pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
}

export function finishCurrentUserRestoreBarrier(next: 'settled' | 'failed'): void {
  phase = next;
  const release = releasePending;
  releasePending = null;
  release?.();
}

export function markCurrentUserRestoreBarrierSettledWithoutAttempt(): void {
  phase = 'settled';
  pending = Promise.resolve();
  releasePending = null;
}

export function __resetCurrentUserRestoreBarrierForTests(): void {
  phase = 'unarmed';
  pending = Promise.resolve();
  releasePending = null;
  accountSwitchDepth = 0;
}

/**
 * Held across Apple credential, sign-in, and the shared restore.
 * Foreground retry must not start an anonymous restore during the switch.
 * This is a depth counter, not a lock that waits on the decision gate or SQLite.
 */
export function beginCurrentUserAccountSwitch(): () => void {
  accountSwitchDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    accountSwitchDepth -= 1;
  };
}

export function isCurrentUserAccountSwitchInProgress(): boolean {
  return accountSwitchDepth > 0;
}

/**
 * Move a failed or settled barrier onto the account that just finished switching.
 * Pending waiters are released. Idle and failed phases are overwritten in place.
 */
export function reconcileCurrentUserRestoreBarrier(next: 'settled' | 'failed'): void {
  if (phase === 'pending') {
    finishCurrentUserRestoreBarrier(next);
    return;
  }
  phase = next;
  pending = Promise.resolve();
  releasePending = null;
}

export async function waitForCurrentUserRestoreAttempt(): Promise<CurrentUserRestorePhase> {
  if (phase === 'pending') await pending;
  return phase;
}

export async function backupMayStartAfterCurrentUserRestore(): Promise<
  { ok: true } | { ok: false; reason: 'restore_failed' }
> {
  if (phase === 'pending') await pending;
  if (phase === 'failed') return { ok: false, reason: 'restore_failed' };
  return { ok: true };
}

/**
 * Returns undefined when the barrier is idle so callers can skip await.
 * An unconditional await yields and can let a later auth change win first.
 */
export function assertCurrentUserRestoreAllowsBusinessWrites(): Promise<void> | void {
  if (phase === 'failed') throw new CurrentUserRestoreBlockedError();
  if (phase !== 'pending') return;
  const wait = pending;
  return wait.then(() => {
    if (phase === 'failed') throw new CurrentUserRestoreBlockedError();
  });
}
