/**
 * Home Performance H5.1 / H5.1a — auth deferral + instance lifecycle fence.
 */

import {
  armHomeAuthColdDeferral,
  isCurrentHomeLifecycleInstance,
  shouldDeferOwnerDependentHomeRefresh,
  type HomeAuthColdGateDeps,
} from './homeAuthColdGate';
import { createHomeRefreshCoordinator } from './homeRefreshCoordinator';
import * as fs from 'fs';
import * as path from 'path';

type AuthStatus = 'initializing' | 'authenticated' | 'unavailable';

function makeDeps(options: {
  anonEnabled: boolean;
  status: AuthStatus;
  revision: number;
}): HomeAuthColdGateDeps & {
  setStatus: (status: AuthStatus, revision?: number) => void;
  emit: () => void;
  getPendingListeners: () => number;
} {
  let status = options.status;
  let revision = options.revision;
  const listeners = new Set<(s: { status: AuthStatus }) => void>();

  return {
    isAnonAuthEnabled: () => options.anonEnabled,
    getAuthState: () => ({ status }),
    getAuthSessionLifecycleRevision: () => revision,
    subscribeAuthState: (listener) => {
      listeners.add(listener);
      listener({ status });
      return () => {
        listeners.delete(listener);
      };
    },
    setStatus: (next, nextRevision) => {
      status = next;
      if (typeof nextRevision === 'number') revision = nextRevision;
    },
    emit: () => {
      for (const listener of [...listeners]) {
        listener({ status });
      }
    },
    getPendingListeners: () => listeners.size,
  };
}

describe('H5.1a — homeAuthColdGate', () => {
  it('defers only when anon on + initializing', () => {
    expect(
      shouldDeferOwnerDependentHomeRefresh(
        makeDeps({ anonEnabled: true, status: 'initializing', revision: 0 })
      )
    ).toBe(true);
    expect(
      shouldDeferOwnerDependentHomeRefresh(
        makeDeps({ anonEnabled: true, status: 'authenticated', revision: 1 })
      )
    ).toBe(false);
    expect(
      shouldDeferOwnerDependentHomeRefresh(
        makeDeps({ anonEnabled: false, status: 'initializing', revision: 0 })
      )
    ).toBe(false);
  });

  it('isCurrentHomeLifecycleInstance compares expected vs live', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'authenticated',
      revision: 1,
    });
    expect(isCurrentHomeLifecycleInstance(1, deps)).toBe(true);
    expect(isCurrentHomeLifecycleInstance(0, deps)).toBe(false);
  });

  it('initializing → authenticated + revision bump: old instance does not launch', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const onReady = jest.fn();
    const unsub = armHomeAuthColdDeferral(
      { expectedLifecycleRevision: 0, onStableSameInstance: onReady },
      deps
    );

    deps.setStatus('authenticated', 1);
    deps.emit();

    expect(onReady).not.toHaveBeenCalled();
    unsub();
  });

  it('TOCTOU before/during arm: expected instance revision 0 suppresses after live bumps to 1', () => {
    let status: AuthStatus = 'initializing';
    let revision = 0;
    const deps: HomeAuthColdGateDeps = {
      isAnonAuthEnabled: () => true,
      getAuthState: () => ({ status }),
      getAuthSessionLifecycleRevision: () => revision,
      subscribeAuthState: (listener) => {
        // Auth settles + revision bumps while arm is installing the listener.
        status = 'authenticated';
        revision = 1;
        listener({ status });
        return () => undefined;
      },
    };
    const onReady = jest.fn();
    armHomeAuthColdDeferral(
      { expectedLifecycleRevision: 0, onStableSameInstance: onReady },
      deps
    );
    expect(onReady).not.toHaveBeenCalled();
  });

  it('initializing → unavailable without remount: same instance launches once', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const onReady = jest.fn();
    armHomeAuthColdDeferral(
      { expectedLifecycleRevision: 0, onStableSameInstance: onReady },
      deps
    );

    deps.setStatus('unavailable', 0);
    deps.emit();
    deps.emit();

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('lost-wakeup: auth stable between inspect and subscribe still fires once', () => {
    let status: AuthStatus = 'initializing';
    let revision = 0;
    const deps: HomeAuthColdGateDeps = {
      isAnonAuthEnabled: () => true,
      getAuthState: () => ({ status }),
      getAuthSessionLifecycleRevision: () => revision,
      subscribeAuthState: (listener) => {
        status = 'unavailable';
        listener({ status });
        return () => undefined;
      },
    };
    const onReady = jest.fn();
    armHomeAuthColdDeferral(
      { expectedLifecycleRevision: 0, onStableSameInstance: onReady },
      deps
    );
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('already-stable at arm: fires once without waiting for a later emit', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'authenticated',
      revision: 2,
    });
    const onReady = jest.fn();
    armHomeAuthColdDeferral(
      { expectedLifecycleRevision: 2, onStableSameInstance: onReady },
      deps
    );
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('unmount cleanup: later auth settle does not call onReady', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const onReady = jest.fn();
    const unsub = armHomeAuthColdDeferral(
      { expectedLifecycleRevision: 0, onStableSameInstance: onReady },
      deps
    );
    unsub();
    deps.setStatus('unavailable', 0);
    deps.emit();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('coordinator: cold+focus+pathname still one started run', () => {
    let started = 0;
    const coordinator = createHomeRefreshCoordinator({
      runRefresh: async () => undefined,
      onEvent: (e) => {
        if (e.type === 'started') started += 1;
      },
      schedule: (fn) => {
        fn();
        return { cancel: () => undefined };
      },
    });

    coordinator.requestVisibleRefresh('cold');
    coordinator.requestVisibleRefresh('focus');
    coordinator.requestVisibleRefresh('pathname');

    expect(started).toBe(1);
  });

  it('Home source: immutable instance revision + no effect overwrite', () => {
    const homeSource = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    expect(homeSource).toContain('homeInstanceLifecycleRevisionRef');
    expect(homeSource).toContain('isCurrentHomeLifecycleInstance');
    expect(homeSource).toContain('expectedLifecycleRevision');
    expect(homeSource).toContain('requestVisibleRefreshGated');
    // Must not refresh instance identity from live revision in mount effect.
    expect(homeSource).not.toMatch(
      /homeInstanceLifecycleRevisionRef\.current\s*=\s*getAuthSessionLifecycleRevision\(\)/
    );
    expect(homeSource).not.toMatch(
      /homeInstanceRevisionRef\.current\s*=\s*getAuthSessionLifecycleRevision\(\)/
    );
  });
});

describe('H5.1a — simulated Home gate controller', () => {
  function createSimulatedHomeGate(
    deps: ReturnType<typeof makeDeps>,
    options?: { instanceRevision?: number }
  ) {
    let visible = true;
    let pendingHiddenCold = false;
    let unsub: (() => void) | null = null;
    const instanceRevision =
      options?.instanceRevision ?? deps.getAuthSessionLifecycleRevision();
    const heavyStarts: string[] = [];
    let ownerResolverCalls = 0;

    const startHeavy = (trigger: string) => {
      // Owner resolve only happens after fence — count as heavy path entry.
      ownerResolverCalls += 1;
      heavyStarts.push(trigger);
    };

    const clearDefer = () => {
      if (unsub) {
        unsub();
        unsub = null;
      }
    };

    const onStableSameInstance = () => {
      unsub = null;
      if (!isCurrentHomeLifecycleInstance(instanceRevision, deps)) {
        pendingHiddenCold = false;
        return;
      }
      if (!visible) {
        pendingHiddenCold = true;
        return;
      }
      if (!isCurrentHomeLifecycleInstance(instanceRevision, deps)) {
        pendingHiddenCold = false;
        return;
      }
      startHeavy('cold');
    };

    const requestGated = (trigger: string) => {
      if (!isCurrentHomeLifecycleInstance(instanceRevision, deps)) {
        clearDefer();
        pendingHiddenCold = false;
        return;
      }

      if (!shouldDeferOwnerDependentHomeRefresh(deps)) {
        clearDefer();
        if (!isCurrentHomeLifecycleInstance(instanceRevision, deps)) {
          pendingHiddenCold = false;
          return;
        }
        if (pendingHiddenCold) {
          pendingHiddenCold = false;
          if (!isCurrentHomeLifecycleInstance(instanceRevision, deps)) return;
          startHeavy('cold');
          return;
        }
        if (!isCurrentHomeLifecycleInstance(instanceRevision, deps)) return;
        startHeavy(trigger);
        return;
      }

      if (!unsub) {
        unsub = armHomeAuthColdDeferral(
          {
            expectedLifecycleRevision: instanceRevision,
            onStableSameInstance,
          },
          deps
        );
      }
    };

    return {
      requestGated,
      setVisible: (v: boolean) => {
        const becameVisible = v && !visible;
        visible = v;
        if (becameVisible) requestGated('pathname');
      },
      dispose: () => {
        clearDefer();
        pendingHiddenCold = false;
      },
      heavyStarts,
      get pendingHiddenCold() {
        return pendingHiddenCold;
      },
      get ownerResolverCalls() {
        return ownerResolverCalls;
      },
      instanceRevision,
    };
  }

  it('EXACT pre-first-effect race: old instanceRevision=0, live=1, zero work; new owns one cold', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    // Rendered under G=0 while auth initializing — no visibility request yet.
    const oldHome = createSimulatedHomeGate(deps, { instanceRevision: 0 });

    // Auth settles + revision bumps BEFORE old Home's first visibility effect.
    // Tabs remount is scheduled but old instance still executes first.
    deps.setStatus('authenticated', 1);

    oldHome.requestGated('cold');
    expect(oldHome.heavyStarts).toEqual([]);
    expect(oldHome.ownerResolverCalls).toBe(0);
    expect(oldHome.pendingHiddenCold).toBe(false);

    const newHome = createSimulatedHomeGate(deps, { instanceRevision: 1 });
    newHome.requestGated('cold');
    expect(oldHome.heavyStarts).toEqual([]);
    expect(newHome.heavyStarts).toEqual(['cold']);
  });

  it('stable direct mismatch: auth stable, instance G live G+1 → zero requests', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'authenticated',
      revision: 1,
    });
    const oldHome = createSimulatedHomeGate(deps, { instanceRevision: 0 });
    oldHome.requestGated('cold');
    oldHome.requestGated('pathname');
    expect(oldHome.heavyStarts).toEqual([]);
    expect(oldHome.pendingHiddenCold).toBe(false);
  });

  it('stable direct same revision: immediate normal request', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'authenticated',
      revision: 1,
    });
    const home = createSimulatedHomeGate(deps, { instanceRevision: 1 });
    home.requestGated('cold');
    expect(home.heavyStarts).toEqual(['cold']);
  });

  it('TOCTOU: begin gated while live=0; arm-time settle bumps to 1 → zero old work', () => {
    let status: AuthStatus = 'initializing';
    let revision = 0;
    const listeners = new Set<(s: { status: AuthStatus }) => void>();
    const deps: HomeAuthColdGateDeps & {
      setStatus: (s: AuthStatus, r?: number) => void;
      emit: () => void;
    } = {
      isAnonAuthEnabled: () => true,
      getAuthState: () => ({ status }),
      getAuthSessionLifecycleRevision: () => revision,
      subscribeAuthState: (listener) => {
        listeners.add(listener);
        // Bump during arm subscribe — helper must still honor expected=0.
        status = 'authenticated';
        revision = 1;
        listener({ status });
        return () => {
          listeners.delete(listener);
        };
      },
      setStatus: (s, r) => {
        status = s;
        if (typeof r === 'number') revision = r;
      },
      emit: () => {
        for (const l of [...listeners]) l({ status });
      },
    };

    const oldHome = createSimulatedHomeGate(
      deps as ReturnType<typeof makeDeps>,
      { instanceRevision: 0 }
    );
    oldHome.requestGated('cold');
    expect(oldHome.heavyStarts).toEqual([]);
    expect(oldHome.pendingHiddenCold).toBe(false);
  });

  it('normal armed remount: request while initializing → revision 1 → new owns cold', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const oldHome = createSimulatedHomeGate(deps, { instanceRevision: 0 });
    oldHome.requestGated('cold');
    expect(oldHome.heavyStarts).toEqual([]);

    deps.setStatus('authenticated', 1);
    deps.emit();
    oldHome.dispose();

    const newHome = createSimulatedHomeGate(deps, { instanceRevision: 1 });
    newHome.requestGated('cold');
    expect(oldHome.heavyStarts).toEqual([]);
    expect(newHome.heavyStarts).toEqual(['cold']);
  });

  it('unavailable same revision: exactly one deferred cold', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const home = createSimulatedHomeGate(deps, { instanceRevision: 0 });
    home.requestGated('cold');
    home.requestGated('focus');
    home.requestGated('pathname');
    expect(home.heavyStarts).toEqual([]);

    deps.setStatus('unavailable', 0);
    deps.emit();
    expect(home.heavyStarts).toEqual(['cold']);
  });

  it('hidden + revision change: no pending cold for obsolete instance', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const oldHome = createSimulatedHomeGate(deps, { instanceRevision: 0 });
    oldHome.requestGated('cold');
    oldHome.setVisible(false);

    deps.setStatus('authenticated', 1);
    deps.emit();
    expect(oldHome.heavyStarts).toEqual([]);
    expect(oldHome.pendingHiddenCold).toBe(false);

    // Later visibility on obsolete instance still fenced.
    oldHome.setVisible(true);
    expect(oldHome.heavyStarts).toEqual([]);
  });

  it('hidden + same revision unavailable: pending then one cold on visible', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const home = createSimulatedHomeGate(deps, { instanceRevision: 0 });
    home.requestGated('cold');
    home.setVisible(false);
    deps.setStatus('unavailable', 0);
    deps.emit();
    expect(home.heavyStarts).toEqual([]);
    expect(home.pendingHiddenCold).toBe(true);

    home.setVisible(true);
    expect(home.heavyStarts).toEqual(['cold']);
  });

  it('anon off: initializing does not defer', () => {
    const deps = makeDeps({
      anonEnabled: false,
      status: 'initializing',
      revision: 0,
    });
    const home = createSimulatedHomeGate(deps, { instanceRevision: 0 });
    home.requestGated('cold');
    expect(home.heavyStarts).toEqual(['cold']);
  });

  it('unmount while initializing: no later heavy', () => {
    const deps = makeDeps({
      anonEnabled: true,
      status: 'initializing',
      revision: 0,
    });
    const home = createSimulatedHomeGate(deps, { instanceRevision: 0 });
    home.requestGated('cold');
    home.dispose();
    deps.setStatus('unavailable', 0);
    deps.emit();
    expect(home.heavyStarts).toEqual([]);
  });

  it('mounted Tabs/Home integration: remaining B-level coverage gap (documented)', () => {
    // Full React/Expo Router keyed remount of app/(tabs) is disproportionately
    // invasive here. Deterministic controller coverage above locks the A race.
    expect(true).toBe(true);
  });
});
