/**
 * Internal Diagnostics V1 — central in-memory service.
 * Best-effort only; never throws into product paths.
 */

import { isInternalDiagnosticsEnabled } from './internalDiagnosticsGate';
import {
  clearPersistedDiagnostics,
  createDiagnosticsPersistScheduler,
  createSerializedStorageQueue,
  loadPersistedDiagnostics,
  savePersistedDiagnostics,
  type InternalDiagnosticsStorageAdapter,
  type PersistedDiagnosticsPayload,
} from './internalDiagnosticsStorage';
import {
  buildDiagnosticEvent,
  DiagnosticRingBuffer,
  INTERNAL_DIAGNOSTICS_RING_CAPACITY,
  INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
  normalizeDiagnosticError,
  boundDiagnosticString,
  type DiagnosticEvent,
  type DiagnosticEventCategory,
} from './internalDiagnosticsTypes';

function createSessionId(): string {
  return `diag_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

type RecordArgs = {
  category: DiagnosticEventCategory;
  name: string;
  screen: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
};

function sortEventsChronologically(
  events: readonly DiagnosticEvent[]
): DiagnosticEvent[] {
  return [...events].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.tRel - b.tRel;
  });
}

class InternalDiagnosticsService {
  private buffer = new DiagnosticRingBuffer(INTERNAL_DIAGNOSTICS_RING_CAPACITY);
  private sessionId = createSessionId();
  private sessionStartedAt = Date.now();
  private monotonicOrigin = Date.now();
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private pendingBeforeHydrate: DiagnosticEvent[] = [];
  private storageAdapter: InternalDiagnosticsStorageAdapter | undefined;
  /** Invalidates stale debounce / persist / hydrate. */
  private generation = 0;
  private storageQueue = createSerializedStorageQueue();
  private persistScheduler = createDiagnosticsPersistScheduler({
    onFlush: () => {
      void this.enqueuePersistSnapshot();
    },
    isEnabled: () => this.isEnabled(),
  });

  /** Test/DI: replace storage + reset state. */
  resetForTests(
    adapter?: InternalDiagnosticsStorageAdapter,
    options?: { debounceMs?: number; hydrated?: boolean }
  ): void {
    this.persistScheduler.cancel();
    this.generation += 1;
    this.storageAdapter = adapter;
    this.storageQueue = createSerializedStorageQueue();
    this.buffer = new DiagnosticRingBuffer(INTERNAL_DIAGNOSTICS_RING_CAPACITY);
    this.sessionId = createSessionId();
    this.sessionStartedAt = Date.now();
    this.monotonicOrigin = Date.now();
    this.hydrated = options?.hydrated ?? true;
    this.hydratePromise = null;
    this.pendingBeforeHydrate = [];
    this.persistScheduler = createDiagnosticsPersistScheduler({
      onFlush: () => {
        void this.enqueuePersistSnapshot();
      },
      isEnabled: () => this.isEnabled(),
      debounceMs: options?.debounceMs ?? 0,
    });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getGenerationForTests(): number {
    return this.generation;
  }

  hasPendingPersistTimerForTests(): boolean {
    return this.persistScheduler.hasPendingTimer();
  }

  async drainStorageForTests(): Promise<void> {
    await this.storageQueue.drain();
  }

  getEventCount(): number {
    return this.buffer.length;
  }

  getRingCapacity(): number {
    return this.buffer.getCapacity();
  }

  isEnabled(): boolean {
    return isInternalDiagnosticsEnabled();
  }

  async ensureHydrated(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.hydrated) return;
    if (this.hydratePromise) return this.hydratePromise;

    const hydrateGen = this.generation;
    this.hydratePromise = (async () => {
      try {
        const loaded = await loadPersistedDiagnostics(this.storageAdapter);
        if (hydrateGen !== this.generation) {
          // Clear/reset won — discard stale hydration.
          return;
        }
        const pending = this.pendingBeforeHydrate;
        this.pendingBeforeHydrate = [];

        // Do NOT adopt persisted session identity — keep process session.
        // Persisted events are untrusted — re-normalize via replaceAllFromUnknown.
        if (loaded) {
          const merged = sortEventsChronologically([
            ...loaded.events,
            ...pending,
          ]);
          this.buffer.replaceAllFromUnknown(merged);
        } else if (pending.length > 0) {
          this.buffer.replaceAllFromUnknown(
            sortEventsChronologically(pending)
          );
        }
      } catch {
        if (hydrateGen !== this.generation) return;
        if (this.pendingBeforeHydrate.length > 0) {
          const pending = this.pendingBeforeHydrate;
          this.pendingBeforeHydrate = [];
          this.buffer.replaceAllFromUnknown(
            sortEventsChronologically(pending)
          );
        }
      } finally {
        if (hydrateGen === this.generation) {
          this.hydrated = true;
        }
      }
    })();
    return this.hydratePromise;
  }

  recordEvent(args: RecordArgs): void {
    try {
      if (!this.isEnabled()) return;
      const now = Date.now();
      const event = buildDiagnosticEvent({
        ts: now,
        tRel: now - this.monotonicOrigin,
        category: args.category,
        name: args.name,
        screen: args.screen,
        sessionId: this.sessionId,
        durationMs: args.durationMs,
        meta: args.meta,
      });

      if (!this.hydrated) {
        this.pendingBeforeHydrate.push(event);
        void this.ensureHydrated().then(() => {
          if (this.isEnabled()) this.persistScheduler.schedule();
        });
        return;
      }

      this.buffer.push(event);
      this.persistScheduler.schedule();
    } catch {
      // never affect app
    }
  }

  recordTiming(
    screen: string,
    name: string,
    durationMs: number,
    meta?: Record<string, unknown>
  ): void {
    this.recordEvent({
      category: 'timing',
      name,
      screen,
      durationMs,
      meta,
    });
  }

  recordWarning(
    screen: string,
    name: string,
    meta?: Record<string, unknown>
  ): void {
    this.recordEvent({
      category: 'warning',
      name,
      screen,
      meta,
    });
  }

  recordError(
    screen: string,
    name: string,
    error?: unknown,
    meta?: Record<string, unknown>
  ): void {
    const safeMeta: Record<string, unknown> = { ...(meta ?? {}) };
    if (error !== undefined) {
      const normalized = normalizeDiagnosticError(error);
      if (normalized) {
        safeMeta.errorName = normalized.name;
        if (normalized.code !== undefined) {
          safeMeta.errorCode = normalized.code;
        }
      }
    }
    this.recordEvent({
      category: 'error',
      name,
      screen,
      meta: safeMeta,
    });
  }

  getSnapshot(): {
    schemaVersion: number;
    sessionId: string;
    sessionStartedAt: number;
    eventCount: number;
    capacity: number;
    enabled: boolean;
    events: DiagnosticEvent[];
  } {
    const events = this.buffer.getAll();
    return {
      schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
      sessionId: this.sessionId,
      sessionStartedAt: this.sessionStartedAt,
      eventCount: events.length,
      capacity: this.buffer.getCapacity(),
      enabled: this.isEnabled(),
      events,
    };
  }

  async clearDiagnostics(): Promise<void> {
    try {
      this.persistScheduler.cancel();
      this.generation += 1;
      this.buffer.clear();
      this.pendingBeforeHydrate = [];
      this.sessionId = createSessionId();
      this.sessionStartedAt = Date.now();
      this.monotonicOrigin = Date.now();
      this.hydrated = true;
      this.hydratePromise = null;

      const clearGen = this.generation;
      await this.storageQueue.enqueue(async () => {
        if (clearGen !== this.generation) return;
        await clearPersistedDiagnostics(this.storageAdapter);
        // If generation advanced again during remove, a newer clear/persist owns storage.
        if (clearGen !== this.generation) return;
      });

      // Post-clear marker under the new session (optional durable trail).
      this.recordEvent({
        category: 'session',
        name: 'diagnostics_cleared',
        screen: 'diagnostics',
      });
      await this.flushPersistence();
    } catch {
      // ignore
    }
  }

  async flushPersistence(): Promise<void> {
    try {
      this.persistScheduler.flush();
      await this.storageQueue.drain();
    } catch {
      // ignore
    }
  }

  private enqueuePersistSnapshot(): Promise<void> {
    if (!this.isEnabled()) return Promise.resolve();
    const persistGen = this.generation;
    const payload: PersistedDiagnosticsPayload = {
      schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
      sessionId: this.sessionId,
      sessionStartedAt: this.sessionStartedAt,
      events: this.buffer.getAll(),
    };

    return this.storageQueue.enqueue(async () => {
      if (persistGen !== this.generation) {
        return;
      }
      await savePersistedDiagnostics(payload, this.storageAdapter);
      // If Clear/reset advanced generation during native setItem, rewrite
      // authoritative current state so stale setItem cannot resurrect.
      if (persistGen !== this.generation) {
        const current: PersistedDiagnosticsPayload = {
          schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
          sessionId: this.sessionId,
          sessionStartedAt: this.sessionStartedAt,
          events: this.buffer.getAll(),
        };
        if (current.events.length === 0) {
          await clearPersistedDiagnostics(this.storageAdapter);
        } else {
          await savePersistedDiagnostics(current, this.storageAdapter);
        }
      }
    });
  }
}

export const internalDiagnostics = new InternalDiagnosticsService();

export function recordDiagnosticEvent(args: RecordArgs): void {
  internalDiagnostics.recordEvent(args);
}

export function recordDiagnosticTiming(
  screen: string,
  name: string,
  durationMs: number,
  meta?: Record<string, unknown>
): void {
  internalDiagnostics.recordTiming(screen, name, durationMs, meta);
}

export function recordDiagnosticWarning(
  screen: string,
  name: string,
  meta?: Record<string, unknown>
): void {
  internalDiagnostics.recordWarning(screen, name, meta);
}

export function recordDiagnosticError(
  screen: string,
  name: string,
  error?: unknown,
  meta?: Record<string, unknown>
): void {
  internalDiagnostics.recordError(screen, name, error, meta);
}

export function getDiagnosticSnapshot() {
  return internalDiagnostics.getSnapshot();
}

export async function clearDiagnostics(): Promise<void> {
  await internalDiagnostics.clearDiagnostics();
}

export async function flushDiagnosticsPersistence(): Promise<void> {
  await internalDiagnostics.flushPersistence();
}

export async function hydrateInternalDiagnostics(): Promise<void> {
  await internalDiagnostics.ensureHydrated();
}

/** Map Home coordinator events into the diagnostics buffer (safe flat meta). */
export function recordHomeCoordinatorDiagnostic(event: {
  type: string;
  [key: string]: unknown;
}): void {
  try {
    if (!isInternalDiagnosticsEnabled()) return;
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (key === 'type') continue;
      if (
        value == null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        meta[key] = value;
      } else if (
        Array.isArray(value) &&
        value.every(
          (item) =>
            item == null ||
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean'
        )
      ) {
        meta[key] = value;
      }
    }
    recordDiagnosticEvent({
      category: 'coordinator',
      name: `home_refresh_${boundDiagnosticString(String(event.type), 80)}`,
      screen: 'home',
      meta,
    });
  } catch {
    // ignore
  }
}
