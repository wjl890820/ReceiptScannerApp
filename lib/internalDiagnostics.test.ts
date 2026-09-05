import * as fs from 'fs';
import * as path from 'path';

import {
  clearDiagnostics,
  getDiagnosticSnapshot,
  internalDiagnostics,
  recordDiagnosticEvent,
  recordDiagnosticTiming,
  recordHomeCoordinatorDiagnostic,
  flushDiagnosticsPersistence,
  hydrateInternalDiagnostics,
} from './internalDiagnostics';
import {
  buildInternalDiagnosticsExportPackage,
  buildInternalDiagnosticsFilename,
  exportInternalDiagnosticsToShare,
  isInternalDiagnosticsExportInProgress,
  resetInternalDiagnosticsExportGuardForTests,
  serializeInternalDiagnosticsExport,
} from './internalDiagnosticsExport';
import {
  isInternalDiagnosticsEnabled,
  setInternalDiagnosticsEnabledForTests,
  shouldShowInternalDiagnosticsSettingsEntry,
} from './internalDiagnosticsGate';
import {
  parsePersistedDiagnostics,
  INTERNAL_DIAGNOSTICS_STORAGE_KEY,
  type InternalDiagnosticsStorageAdapter,
} from './internalDiagnosticsStorage';
import {
  DiagnosticRingBuffer,
  INTERNAL_DIAGNOSTICS_LEGACY_SCHEMA_VERSION,
  INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES,
  INTERNAL_DIAGNOSTICS_MAX_META_KEYS,
  INTERNAL_DIAGNOSTICS_MAX_STRING_CHARS,
  INTERNAL_DIAGNOSTICS_RING_CAPACITY,
  INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
  buildDiagnosticEvent,
  canonicalizeDiagnosticMetaKey,
  estimateDiagnosticEventBytes,
  isGenuineDiagnosticError,
  normalizeDiagnosticError,
  normalizeDiagnosticEventFromUnknown,
  sanitizeDiagnosticMeta,
  utf8ByteLength,
} from './internalDiagnosticsTypes';
import {
  logHomeRefreshCoordinatorEvent,
  recordHomeRefreshTiming,
  enableHomeRefreshTimingsForTests,
} from './homeRefreshTimings';
import {
  enableAnalysisRefreshTimingsForTests,
  recordAnalysisRefreshTiming,
} from './analysisRefreshTimings';
import { createHomeRefreshCoordinator } from './homeRefreshCoordinator';
import { logger } from './logger';

function memoryStorage(): InternalDiagnosticsStorageAdapter & {
  store: Map<string, string>;
  setItemCalls: number;
} {
  const store = new Map<string, string>();
  return {
    store,
    setItemCalls: 0,
    async getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async setItem(key, value) {
      this.setItemCalls += 1;
      store.set(key, value);
    },
    async removeItem(key) {
      store.delete(key);
    },
  };
}

function deferredStorage(): InternalDiagnosticsStorageAdapter & {
  store: Map<string, string>;
  pendingSets: Array<{
    key: string;
    value: string;
    resolve: () => void;
  }>;
  resolveNextSet: () => void;
  resolveAllSets: () => void;
} {
  const store = new Map<string, string>();
  const pendingSets: Array<{
    key: string;
    value: string;
    resolve: () => void;
  }> = [];
  return {
    store,
    pendingSets,
    async getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async setItem(key, value) {
      await new Promise<void>((resolve) => {
        pendingSets.push({ key, value, resolve });
      });
      store.set(key, value);
    },
    async removeItem(key) {
      store.delete(key);
    },
    resolveNextSet() {
      const next = pendingSets.shift();
      next?.resolve();
    },
    resolveAllSets() {
      while (pendingSets.length > 0) this.resolveNextSet();
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  maxTurns = 50
): Promise<void> {
  for (let i = 0; i < maxTurns; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Independent UTF-8 sizing (Node Buffer) — must not share production helper bugs. */
function independentUtf8ByteLength(value: string): number {
  return Buffer.from(value, 'utf8').byteLength;
}

describe('Internal Diagnostics V1 hardening', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    enableHomeRefreshTimingsForTests(true);
    enableAnalysisRefreshTimingsForTests(true);
    resetInternalDiagnosticsExportGuardForTests();
    internalDiagnostics.resetForTests(memoryStorage());
  });

  afterEach(() => {
    setInternalDiagnosticsEnabledForTests(null);
    enableHomeRefreshTimingsForTests(false);
    enableAnalysisRefreshTimingsForTests(false);
    resetInternalDiagnosticsExportGuardForTests();
  });

  it('production-disabled: no buffer growth, no timer, no setItem, no Settings', async () => {
    const storage = memoryStorage();
    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(storage, { debounceMs: 50 });
    setInternalDiagnosticsEnabledForTests(false);

    expect(shouldShowInternalDiagnosticsSettingsEntry(false)).toBe(false);
    expect(isInternalDiagnosticsEnabled()).toBe(false);

    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'focus',
      screen: 'home',
    });
    logger.warn('Home', 'secret fail', {
      productName: '秘密の商品',
      token: 'secret-token',
    });
    expect(getDiagnosticSnapshot().eventCount).toBe(0);
    expect(internalDiagnostics.hasPendingPersistTimerForTests()).toBe(false);
    await flushDiagnosticsPersistence();
    expect(storage.setItemCalls).toBe(0);
    expect(storage.store.size).toBe(0);
  });

  it('ring buffer capacity evicts oldest', () => {
    const ring = new DiagnosticRingBuffer(3);
    for (let i = 0; i < 5; i += 1) {
      ring.push({
        ts: i,
        tRel: i,
        category: 'lifecycle',
        name: `e${i}`,
        screen: 'home',
        sessionId: 's',
      });
    }
    expect(ring.getAll().map((e) => e.name)).toEqual(['e2', 'e3', 'e4']);
    expect(INTERNAL_DIAGNOSTICS_RING_CAPACITY).toBe(800);
  });

  it('logger bridge drops arbitrary sensitive payloads', () => {
    logger.warn('Home', 'background refresh failed', {
      productName: '秘密の商品',
      merchant: '秘密スーパー',
      ocrText: 'FULL OCR',
      email: 'x@example.com',
      token: 'secret-token',
      url: 'https://example.com/?token=secret',
      response: { body: 'leak' },
    });
    logger.error(
      'Analysis',
      'load failed',
      Object.assign(new Error('https://api.example.com/?token=abc'), {
        name: 'TypeError',
        code: 'E_FAIL',
      })
    );

    const json = JSON.stringify(getDiagnosticSnapshot().events);
    expect(json).not.toContain('秘密の商品');
    expect(json).not.toContain('秘密スーパー');
    expect(json).not.toContain('FULL OCR');
    expect(json).not.toContain('x@example.com');
    expect(json).not.toContain('secret-token');
    expect(json).not.toContain('token=secret');
    expect(json).not.toContain('token=abc');
    expect(json).not.toContain('huge stack');
    expect(json).toContain('background refresh failed');
    expect(json).toContain('TypeError');
    expect(json).toContain('E_FAIL');
  });

  it('meta privacy: huge/nested/circular cannot explode export', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const meta: Record<string, unknown> = {
      productName: '秘密の商品',
      merchant: '秘密スーパー',
      ocrText: 'x'.repeat(5000),
      email: 'x@example.com',
      token: 'secret-token',
      url: 'https://x/?token=secret',
      response: { nested: { deep: true } },
      okCount: 3,
      flags: [true, false, 1],
      circular,
    };
    for (let i = 0; i < 100; i += 1) {
      meta[`k${i}`] = `v${i}-${'y'.repeat(300)}`;
    }

    expect(() =>
      recordDiagnosticEvent({
        category: 'timing',
        name: 'total',
        screen: 'home',
        durationMs: 1,
        meta,
      })
    ).not.toThrow();

    const sanitized = sanitizeDiagnosticMeta(meta);
    expect(Object.keys(sanitized ?? {}).length).toBeLessThanOrEqual(
      INTERNAL_DIAGNOSTICS_MAX_META_KEYS
    );
    expect(sanitized?.productName).toBeUndefined();
    expect(sanitized?.merchant).toBeUndefined();
    expect(sanitized?.okCount).toBe(3);

    const event = getDiagnosticSnapshot().events[0]!;
    expect(estimateDiagnosticEventBytes(event)).toBeLessThanOrEqual(
      INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
    );
    const exported = serializeInternalDiagnosticsExport({
      schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
      generatedAt: '',
      generatedAtMs: 0,
      app: { version: '1', build: '1', name: 't' },
      device: { platform: 'ios', osVersion: null, model: null },
      featureFlags: {
        ANALYSIS_PRICE_CHANGES_ENABLED: false,
        ENABLE_INTERNAL_DIAGNOSTICS: true,
        ENABLE_ANALYSIS_D_DIAGNOSTICS: false,
        ENABLE_ANON_AUTH: false,
        ENABLE_CLOUD_BACKUP: false,
        ENABLE_APPLE_LINK: false,
      },
      dataScale: {
        receiptCount: null,
        receiptItemCount: null,
        personalIdentityDecisionCount: null,
        shoppingListItemCount: null,
        shoppingListIncompleteCount: null,
        notes: [],
      },
      session: {
        sessionId: 's',
        sessionStartedAt: 0,
        eventCount: 1,
        capacity: 800,
        locale: 'en',
      },
      events: [event],
      privacy: {
        includesRawReceiptContent: false,
        includesProductNames: false,
        includesMerchantNames: false,
        includesImages: false,
        includesCredentials: false,
      },
    });
    expect(exported).not.toContain('秘密の商品');
    expect(exported).not.toContain('secret-token');
  });

  it('per-event byte budget clamps pathological metadata', () => {
    const meta: Record<string, unknown> = {};
    for (let i = 0; i < 24; i += 1) {
      meta[`field${i}`] = 'z'.repeat(INTERNAL_DIAGNOSTICS_MAX_STRING_CHARS);
    }
    const event = buildDiagnosticEvent({
      ts: 1,
      tRel: 1,
      category: 'timing',
      name: 'total',
      screen: 'home',
      sessionId: 's',
      meta,
    });
    expect(estimateDiagnosticEventBytes(event)).toBeLessThanOrEqual(
      INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
    );
  });

  it('persistence latest-write-wins under adversarial setItem order', async () => {
    const storage = deferredStorage();
    internalDiagnostics.resetForTests(storage, { debounceMs: 0 });

    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'A',
      screen: 'home',
    });
    void flushDiagnosticsPersistence();
    await waitFor(() => storage.pendingSets.length >= 1, 'A setItem pending');

    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'B',
      screen: 'home',
    });
    void flushDiagnosticsPersistence();

    // Adversarial: resolve older write first, then newer.
    storage.resolveAllSets();
    // B may enqueue after A resolves — keep resolving until drained.
    for (let i = 0; i < 10; i += 1) {
      storage.resolveAllSets();
      await Promise.resolve();
    }
    await internalDiagnostics.drainStorageForTests();

    const parsed = parsePersistedDiagnostics(
      storage.store.get(INTERNAL_DIAGNOSTICS_STORAGE_KEY)!
    );
    expect(parsed?.events.map((e) => e.name)).toEqual(
      expect.arrayContaining(['A', 'B'])
    );
    expect(parsed?.events.some((e) => e.name === 'B')).toBe(true);
  }, 10000);

  it('clear vs in-flight write: stale setItem cannot resurrect', async () => {
    const storage = deferredStorage();
    internalDiagnostics.resetForTests(storage, { debounceMs: 0 });
    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'old',
      screen: 'home',
    });
    void flushDiagnosticsPersistence();
    await waitFor(() => storage.pendingSets.length >= 1, 'old setItem pending');

    const clearPromise = clearDiagnostics();
    await Promise.resolve();
    for (let i = 0; i < 20; i += 1) {
      storage.resolveAllSets();
      await Promise.resolve();
    }
    await clearPromise;
    await internalDiagnostics.drainStorageForTests();

    const raw = storage.store.get(INTERNAL_DIAGNOSTICS_STORAGE_KEY);
    const parsed = parsePersistedDiagnostics(raw ?? null);
    expect(parsed?.events.some((e) => e.name === 'old')).toBeFalsy();
  }, 10000);

  it('clear vs pending debounce cannot resurrect old events', async () => {
    const storage = memoryStorage();
    internalDiagnostics.resetForTests(storage, { debounceMs: 30 });
    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'old',
      screen: 'home',
    });
    expect(internalDiagnostics.hasPendingPersistTimerForTests()).toBe(true);
    await clearDiagnostics();
    expect(internalDiagnostics.hasPendingPersistTimerForTests()).toBe(false);
    await internalDiagnostics.drainStorageForTests();
    await new Promise((r) => setTimeout(r, 50));
    await internalDiagnostics.drainStorageForTests();

    const raw = storage.store.get(INTERNAL_DIAGNOSTICS_STORAGE_KEY);
    const parsed = parsePersistedDiagnostics(raw ?? null);
    expect(parsed?.events.some((e) => e.name === 'old')).toBeFalsy();
  });

  it('post-clear new events persist without old events', async () => {
    const storage = memoryStorage();
    internalDiagnostics.resetForTests(storage, { debounceMs: 0 });
    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'old',
      screen: 'home',
    });
    await flushDiagnosticsPersistence();
    await clearDiagnostics();
    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'new',
      screen: 'home',
    });
    await flushDiagnosticsPersistence();
    const parsed = parsePersistedDiagnostics(
      storage.store.get(INTERNAL_DIAGNOSTICS_STORAGE_KEY)!
    );
    expect(parsed?.events.some((e) => e.name === 'old')).toBe(false);
    expect(parsed?.events.some((e) => e.name === 'new')).toBe(true);
  });

  it('hydration keeps process session id; old events retain old session', async () => {
    const storage = memoryStorage();
    await storage.setItem(
      INTERNAL_DIAGNOSTICS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
        sessionId: 'session-old',
        sessionStartedAt: 1,
        events: [
          {
            ts: 10,
            tRel: 1,
            category: 'lifecycle',
            name: 'historic',
            screen: 'home',
            sessionId: 'session-old',
          },
        ],
      })
    );

    internalDiagnostics.resetForTests(storage, { hydrated: false });
    const processSession = internalDiagnostics.getSessionId();
    expect(processSession).not.toBe('session-old');

    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'early',
      screen: 'home',
    });
    await hydrateInternalDiagnostics();

    const snap = getDiagnosticSnapshot();
    expect(snap.sessionId).toBe(processSession);
    expect(snap.events.find((e) => e.name === 'historic')?.sessionId).toBe(
      'session-old'
    );
    expect(snap.events.find((e) => e.name === 'early')?.sessionId).toBe(
      processSession
    );
    expect(snap.events.some((e) => e.name === 'early')).toBe(true);
  });

  it('clear vs in-flight hydration discards stale load', async () => {
    let resolveGet!: (v: string | null) => void;
    const storage: InternalDiagnosticsStorageAdapter = {
      async getItem() {
        return await new Promise<string | null>((r) => {
          resolveGet = r;
        });
      },
      async setItem() {},
      async removeItem() {},
    };

    internalDiagnostics.resetForTests(storage, { hydrated: false });
    const hydrate = hydrateInternalDiagnostics();
    await clearDiagnostics();
    resolveGet(
      JSON.stringify({
        schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
        sessionId: 'session-old',
        sessionStartedAt: 1,
        events: [
          {
            ts: 1,
            tRel: 1,
            category: 'lifecycle',
            name: 'should_not_appear',
            screen: 'home',
            sessionId: 'session-old',
          },
        ],
      })
    );
    await hydrate;
    expect(
      getDiagnosticSnapshot().events.some((e) => e.name === 'should_not_appear')
    ).toBe(false);
  });

  it('export snapshot eventCount matches events; AP-3 false; no secrets', async () => {
    recordDiagnosticEvent({
      category: 'lifecycle',
      name: 'focus',
      screen: 'home',
    });
    const pkg = await buildInternalDiagnosticsExportPackage({
      locale: 'en',
      app: { version: '1', build: '1', name: 't' },
      device: { platform: 'ios', osVersion: '1', model: null },
      collectDataScale: async () => ({
        receiptCount: 1,
        receiptItemCount: 2,
        personalIdentityDecisionCount: 0,
        shoppingListItemCount: 0,
        shoppingListIncompleteCount: 0,
        notes: [],
      }),
      readFeatureFlags: () => ({
        ANALYSIS_PRICE_CHANGES_ENABLED: false,
        ENABLE_INTERNAL_DIAGNOSTICS: true,
        ENABLE_ANALYSIS_D_DIAGNOSTICS: false,
        ENABLE_ANON_AUTH: false,
        ENABLE_CLOUD_BACKUP: false,
        ENABLE_APPLE_LINK: false,
      }),
    });
    expect(pkg.session.eventCount).toBe(pkg.events.length);
    expect(pkg.featureFlags.ANALYSIS_PRICE_CHANGES_ENABLED).toBe(false);
    expect(pkg.events.some((e) => e.name === 'focus')).toBe(true);
    expect(buildInternalDiagnosticsFilename(0)).toMatch(
      /^meruno-diagnostics-\d{8}-\d{6}\.json$/
    );
  });

  it('parallel export guard returns busy', async () => {
    let resolveShare!: () => void;
    const sharePromise = new Promise<void>((r) => {
      resolveShare = r;
    });
    const first = exportInternalDiagnosticsToShare({
      cacheDirectory: '/tmp/',
      writeAsStringAsync: async () => undefined,
      shareAsync: async () => sharePromise,
      nowMs: 1,
    });
    await Promise.resolve();
    expect(isInternalDiagnosticsExportInProgress()).toBe(true);
    const second = await exportInternalDiagnosticsToShare({
      cacheDirectory: '/tmp/',
      writeAsStringAsync: async () => undefined,
      shareAsync: async () => undefined,
      nowMs: 1,
    });
    expect(second.status).toBe('busy');
    resolveShare();
    const firstResult = await first;
    expect(firstResult.status).toBe('shared');
  });

  it('Home/Analysis timings still enter diagnostics', () => {
    recordHomeRefreshTiming({
      stage: 'listReceipts',
      durationMs: 10,
      receiptCount: 1,
    });
    recordAnalysisRefreshTiming({
      stage: 'total',
      durationMs: 11,
    });
    logHomeRefreshCoordinatorEvent({
      type: 'started',
      runId: 1,
      visibilityEpoch: 1,
      triggers: ['focus'],
    });
    expect(
      getDiagnosticSnapshot().events.some((e) => e.name === 'listReceipts')
    ).toBe(true);
    expect(
      getDiagnosticSnapshot().events.some((e) => e.name === 'total')
    ).toBe(true);
    expect(
      getDiagnosticSnapshot().events.some(
        (e) => e.name === 'home_refresh_started'
      )
    ).toBe(true);
  });

  it('diagnostics recording does not alter refresh coalescing', () => {
    let runs = 0;
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: () => {
        runs += 1;
      },
      onEvent: (e) => recordHomeCoordinatorDiagnostic(e),
    });
    coordinator.requestVisibleRefresh('focus');
    coordinator.requestVisibleRefresh('pathname');
    flushHolder.flush?.();
    expect(runs).toBe(1);
  });

  it('ANALYSIS_PRICE_CHANGES gate is fail-closed; env has no duplicate diagnostics gate', () => {
    const analysis = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(analysis).toContain('isAnalysisPriceChangesEnabled');
    expect(analysis).not.toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
    const envSource = fs.readFileSync(
      path.resolve(__dirname, './env.ts'),
      'utf8'
    );
    expect(envSource).not.toContain(
      'export function isInternalDiagnosticsEnabled'
    );
  });

  it('malformed persistence ignored', () => {
    expect(parsePersistedDiagnostics('{bad')).toBeNull();
    expect(
      parsePersistedDiagnostics(JSON.stringify({ schemaVersion: 99 }))
    ).toBeNull();
  });

  it('legacy schema v1 is discarded without migration', () => {
    expect(INTERNAL_DIAGNOSTICS_LEGACY_SCHEMA_VERSION).toBe(1);
    expect(INTERNAL_DIAGNOSTICS_SCHEMA_VERSION).toBe(2);
    expect(
      parsePersistedDiagnostics(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'old',
          sessionStartedAt: 1,
          events: [
            {
              ts: 1,
              tRel: 1,
              category: 'lifecycle',
              name: 'legacy',
              screen: 'home',
              sessionId: 'old',
            },
          ],
        })
      )
    ).toBeNull();
  });

  it('arbitrary {name,code} object is NOT treated as Error', () => {
    const fake = {
      name: '秘密商品',
      code: 'secret-token',
      product_name: '秘密',
    };
    expect(isGenuineDiagnosticError(fake)).toBe(false);
    expect(normalizeDiagnosticError(fake)).toBeNull();

    logger.error('Home', 'failed', fake);
    const json = JSON.stringify(getDiagnosticSnapshot().events);
    expect(json).not.toContain('秘密商品');
    expect(json).not.toContain('secret-token');
    expect(json).not.toContain('秘密');
    expect(json).not.toContain('"errorName"');
    expect(json).not.toContain('"errorCode"');
  });

  it('genuine Error yields only safe name/code; never message', () => {
    const err = new Error('sensitive message');
    err.name = 'TypeError';
    (err as { code?: string }).code = 'E_TIMEOUT';

    expect(isGenuineDiagnosticError(err)).toBe(true);
    const normalized = normalizeDiagnosticError(err);
    expect(normalized).toEqual({ name: 'TypeError', code: 'E_TIMEOUT' });

    logger.error('Home', 'failed', err);
    const json = JSON.stringify(getDiagnosticSnapshot().events);
    expect(json).toContain('TypeError');
    expect(json).toContain('E_TIMEOUT');
    expect(json).not.toContain('sensitive message');
  });

  it('sensitive-key variant matrix is excluded; safe keys remain', () => {
    const meta: Record<string, unknown> = {
      productName: 'a',
      product_name: 'b',
      'product-name': 'c',
      email: 'd',
      emailAddress: 'e',
      email_address: 'f',
      accountId: 'g',
      account_id: 'h',
      analysis: 'i',
      ocrText: 'j',
      merchant: 'k',
      receipt: 'l',
      token: 'm',
      authorization: 'n',
      apiKey: 'o',
      cycleId: 'cycle-1',
      receiptCount: 3,
      analyticsReceiptCount: 4,
      duration: 5,
      trigger: 'focus',
      epoch: 2,
      status: 'ok',
    };
    expect(canonicalizeDiagnosticMetaKey('product_name')).toBe('productname');
    expect(canonicalizeDiagnosticMetaKey('emailAddress')).toBe('emailaddress');
    expect(canonicalizeDiagnosticMetaKey('account-id')).toBe('accountid');

    const sanitized = sanitizeDiagnosticMeta(meta);
    expect(sanitized?.productName).toBeUndefined();
    expect(sanitized?.product_name).toBeUndefined();
    expect(sanitized?.['product-name']).toBeUndefined();
    expect(sanitized?.email).toBeUndefined();
    expect(sanitized?.emailAddress).toBeUndefined();
    expect(sanitized?.email_address).toBeUndefined();
    expect(sanitized?.accountId).toBeUndefined();
    expect(sanitized?.account_id).toBeUndefined();
    expect(sanitized?.analysis).toBeUndefined();
    expect(sanitized?.ocrText).toBeUndefined();
    expect(sanitized?.merchant).toBeUndefined();
    expect(sanitized?.receipt).toBeUndefined();
    expect(sanitized?.token).toBeUndefined();
    expect(sanitized?.authorization).toBeUndefined();
    expect(sanitized?.apiKey).toBeUndefined();
    expect(sanitized?.cycleId).toBe('cycle-1');
    expect(sanitized?.receiptCount).toBe(3);
    expect(sanitized?.analyticsReceiptCount).toBe(4);
    expect(sanitized?.duration).toBe(5);
    expect(sanitized?.trigger).toBe('focus');
    expect(sanitized?.epoch).toBe(2);
    expect(sanitized?.status).toBe('ok');
  });

  it('multibyte UTF-8 byte-budget: JS length under 6144 but UTF-8 over is clamped', () => {
    const cjk = '秘密商品日本語テスト🎉'.repeat(12); // multibyte cluster
    const meta: Record<string, unknown> = {};
    for (let i = 0; i < 18; i += 1) {
      meta[`field${i}`] = cjk.slice(0, 180);
    }
    const rawish = {
      ts: 1,
      tRel: 1,
      category: 'timing' as const,
      name: 'total',
      screen: 'home',
      sessionId: 's',
      meta,
    };
    // Simulate pre-normalization payload size characteristics.
    const rawJson = JSON.stringify({
      ...rawish,
      meta: Object.fromEntries(
        Object.entries(meta).map(([k, v]) => [k, String(v).slice(0, 180)])
      ),
    });
    expect(rawJson.length).toBeLessThan(INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES);
    expect(independentUtf8ByteLength(rawJson)).toBeGreaterThan(
      INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
    );

    const event = buildDiagnosticEvent(rawish);
    const serialized = JSON.stringify(event);
    expect(utf8ByteLength(serialized)).toBeLessThanOrEqual(
      INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
    );
    expect(independentUtf8ByteLength(serialized)).toBeLessThanOrEqual(
      INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
    );
    expect(estimateDiagnosticEventBytes(event)).toBe(
      independentUtf8ByteLength(serialized)
    );
  });

  it('hydrated current-schema sensitive event cannot leak', async () => {
    const storage = memoryStorage();
    await storage.setItem(
      INTERNAL_DIAGNOSTICS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
        sessionId: 'session-old',
        sessionStartedAt: 1,
        events: [
          {
            ts: 10,
            tRel: 1,
            category: 'timing',
            name: 'total',
            screen: 'home',
            sessionId: 'session-old',
            meta: {
              product_name: '秘密商品',
              emailAddress: 'x@example.com',
              accountId: '123',
              analysis: 'raw analysis',
              token: 'secret',
              nested: {
                merchant: 'secret supermarket',
              },
              okCount: 7,
            },
          },
        ],
      })
    );

    internalDiagnostics.resetForTests(storage, { hydrated: false });
    await hydrateInternalDiagnostics();

    const snap = getDiagnosticSnapshot();
    const liveJson = JSON.stringify(snap);
    expect(liveJson).not.toContain('秘密商品');
    expect(liveJson).not.toContain('x@example.com');
    expect(liveJson).not.toContain('"123"');
    expect(liveJson).not.toContain('raw analysis');
    expect(liveJson).not.toContain('secret');
    expect(liveJson).not.toContain('secret supermarket');
    expect(snap.events[0]?.meta?.okCount).toBe(7);
    expect(snap.events[0]?.meta?.nested).toBeUndefined();
    expect(snap.events[0]?.meta?.product_name).toBeUndefined();

    const pkg = await buildInternalDiagnosticsExportPackage({
      locale: 'en',
      app: { version: '1', build: '1', name: 't' },
      device: { platform: 'ios', osVersion: '1', model: null },
      collectDataScale: async () => ({
        receiptCount: 0,
        receiptItemCount: 0,
        personalIdentityDecisionCount: 0,
        shoppingListItemCount: 0,
        shoppingListIncompleteCount: 0,
        notes: [],
      }),
      readFeatureFlags: () => ({
        ANALYSIS_PRICE_CHANGES_ENABLED: false,
        ENABLE_INTERNAL_DIAGNOSTICS: true,
        ENABLE_ANALYSIS_D_DIAGNOSTICS: false,
        ENABLE_ANON_AUTH: false,
        ENABLE_CLOUD_BACKUP: false,
        ENABLE_APPLE_LINK: false,
      }),
    });
    const exportJson = serializeInternalDiagnosticsExport(pkg);
    expect(exportJson).not.toContain('秘密商品');
    expect(exportJson).not.toContain('x@example.com');
    expect(exportJson).not.toContain('raw analysis');
    expect(exportJson).not.toContain('secret supermarket');
  });

  it('hydrated oversized multibyte event is clamped or rejected', async () => {
    const cjk = '漢字カタカナ🎉'.repeat(40);
    const meta: Record<string, unknown> = {};
    for (let i = 0; i < 30; i += 1) {
      meta[`blob${i}`] = cjk;
    }
    const oversized = {
      ts: 10,
      tRel: 1,
      category: 'timing',
      name: 'total',
      screen: 'home',
      sessionId: 'session-old',
      meta,
    };
    const rawJson = JSON.stringify(oversized);
    expect(independentUtf8ByteLength(rawJson)).toBeGreaterThan(
      INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
    );

    const storage = memoryStorage();
    await storage.setItem(
      INTERNAL_DIAGNOSTICS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
        sessionId: 'session-old',
        sessionStartedAt: 1,
        events: [oversized],
      })
    );

    internalDiagnostics.resetForTests(storage, { hydrated: false });
    await hydrateInternalDiagnostics();

    const snap = getDiagnosticSnapshot();
    for (const event of snap.events) {
      expect(independentUtf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(
        INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
      );
    }
    // Either rejected or clamped — never over budget in live memory.
    if (snap.events.length > 0) {
      expect(estimateDiagnosticEventBytes(snap.events[0]!)).toBeLessThanOrEqual(
        INTERNAL_DIAGNOSTICS_MAX_EVENT_BYTES
      );
    }
  });

  it('matching current schema still re-normalizes on hydrate', async () => {
    const storage = memoryStorage();
    await storage.setItem(
      INTERNAL_DIAGNOSTICS_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
        sessionId: 'session-old',
        sessionStartedAt: 1,
        events: [
          {
            ts: 10,
            tRel: 1,
            category: 'timing',
            name: 'x'.repeat(500),
            screen: 'home',
            sessionId: 'session-old',
            meta: {
              productName: 'leak',
              cycleId: 'c1',
            },
          },
        ],
      })
    );
    internalDiagnostics.resetForTests(storage, { hydrated: false });
    await hydrateInternalDiagnostics();
    const event = getDiagnosticSnapshot().events[0]!;
    expect(event.name.length).toBeLessThanOrEqual(120);
    expect(event.meta?.productName).toBeUndefined();
    expect(event.meta?.cycleId).toBe('c1');
  });

  it('normalizeDiagnosticEventFromUnknown rejects malformed', () => {
    expect(normalizeDiagnosticEventFromUnknown(null)).toBeNull();
    expect(normalizeDiagnosticEventFromUnknown({ ts: 1 })).toBeNull();
    expect(
      normalizeDiagnosticEventFromUnknown({
        ts: 1,
        tRel: 1,
        category: 'not-a-category',
        name: 'n',
        screen: 's',
        sessionId: 'id',
      })
    ).toBeNull();
  });
});
