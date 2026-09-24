/**
 * Home Performance H5.1 / H5.1a — suppress doomed pre-auth owner-dependent cold
 * refresh, with an immutable Home-instance lifecycle revision fence.
 *
 * When anon auth is enabled and auth is still `initializing`, Home must not start
 * heavy owner-scoped work that will commonly be disposed by the authenticated
 * Tabs remount. Lifecycle fencing additionally ensures an obsolete Home instance
 * never launches work after live sessionLifecycleRevision has moved on.
 *
 * This module is lifecycle-only; owner/readiness authority is unchanged.
 */

import type { AuthState } from './anonAuth';

export type HomeAuthColdGateAuthState = Pick<AuthState, 'status'>;

export type HomeAuthColdGateDeps = {
  isAnonAuthEnabled: () => boolean;
  getAuthState: () => HomeAuthColdGateAuthState;
  getAuthSessionLifecycleRevision: () => number;
  subscribeAuthState: (
    listener: (state: HomeAuthColdGateAuthState) => void
  ) => () => void;
};

function defaultDeps(): HomeAuthColdGateDeps {
  // Lazy require keeps Jest suites that mock anonAuth/env free of circular pulls.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const anonAuth = require('./anonAuth') as typeof import('./anonAuth');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const env = require('./env') as typeof import('./env');
  return {
    isAnonAuthEnabled: () => env.isAnonAuthEnabled(),
    getAuthState: () => anonAuth.getAuthState(),
    getAuthSessionLifecycleRevision: () =>
      anonAuth.getAuthSessionLifecycleRevision(),
    subscribeAuthState: (listener) => anonAuth.subscribeAuthState(listener),
  };
}

/** True when Home must not start owner-dependent heavy visibility refresh yet. */
export function shouldDeferOwnerDependentHomeRefresh(
  deps: HomeAuthColdGateDeps = defaultDeps()
): boolean {
  if (!deps.isAnonAuthEnabled()) return false;
  return deps.getAuthState().status === 'initializing';
}

/**
 * H5.1a — true only while live sessionLifecycleRevision still equals the
 * revision identity captured for THIS Home component instance.
 */
export function isCurrentHomeLifecycleInstance(
  expectedLifecycleRevision: number,
  deps: HomeAuthColdGateDeps = defaultDeps()
): boolean {
  return (
    deps.getAuthSessionLifecycleRevision() === expectedLifecycleRevision
  );
}

/**
 * Arm a race-safe waiter for auth leaving `initializing`.
 *
 * `expectedLifecycleRevision` MUST be the Home instance's immutable identity
 * (captured at render), never a later live revision observed at arm time.
 *
 * If live sessionLifecycleRevision differs from expectedLifecycleRevision
 * (uid-changing remount), onStableSameInstance is NOT called.
 *
 * If auth becomes authenticated/unavailable without a revision bump, calls
 * onStableSameInstance exactly once.
 */
export function armHomeAuthColdDeferral(
  options: {
    expectedLifecycleRevision: number;
    onStableSameInstance: () => void;
  },
  deps: HomeAuthColdGateDeps = defaultDeps()
): () => void {
  let settled = false;

  const handle = (state: HomeAuthColdGateAuthState) => {
    if (settled) return;
    if (state.status === 'initializing') return;
    settled = true;
    // Revision is bumped inside the same setState that emits listeners for
    // authenticated uid transitions — compare AFTER status is stable.
    if (
      deps.getAuthSessionLifecycleRevision() !==
      options.expectedLifecycleRevision
    ) {
      return;
    }
    options.onStableSameInstance();
  };

  // Race-safe: inspect → subscribe (sync notify) → re-read.
  void deps.getAuthState();
  const unsubscribe = deps.subscribeAuthState(handle);
  handle(deps.getAuthState());

  return () => {
    settled = true;
    unsubscribe();
  };
}
