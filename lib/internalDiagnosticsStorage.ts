/**
 * Best-effort AsyncStorage persistence for Internal Diagnostics V1.
 * Debounced scheduling + serialized storage ops; never throws to callers.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
  type DiagnosticEvent,
} from './internalDiagnosticsTypes';

export const INTERNAL_DIAGNOSTICS_STORAGE_KEY =
  '@meruno/internal_diagnostics_v1';

export const INTERNAL_DIAGNOSTICS_PERSIST_DEBOUNCE_MS = 1500;

export type PersistedDiagnosticsPayload = {
  schemaVersion: number;
  /** Process session that last wrote; historical events keep their own ids. */
  sessionId: string;
  sessionStartedAt: number;
  events: DiagnosticEvent[];
};

export type InternalDiagnosticsStorageAdapter = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

const defaultAdapter: InternalDiagnosticsStorageAdapter = AsyncStorage;

export function parsePersistedDiagnostics(
  raw: string | null | undefined
): PersistedDiagnosticsPayload | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedDiagnosticsPayload>;
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== INTERNAL_DIAGNOSTICS_SCHEMA_VERSION ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.sessionStartedAt !== 'number' ||
      !Array.isArray(parsed.events)
    ) {
      return null;
    }
    // Structural pass only — hydration re-normalizes every event (privacy/size).
    // Do not treat storage contents as a trusted DiagnosticEvent boundary.
    const events: DiagnosticEvent[] = [];
    for (const item of parsed.events) {
      if (!item || typeof item !== 'object') continue;
      events.push(item as DiagnosticEvent);
    }
    return {
      schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
      sessionId: parsed.sessionId,
      sessionStartedAt: parsed.sessionStartedAt,
      events,
    };
  } catch {
    return null;
  }
}

export async function loadPersistedDiagnostics(
  adapter: InternalDiagnosticsStorageAdapter = defaultAdapter
): Promise<PersistedDiagnosticsPayload | null> {
  try {
    const raw = await adapter.getItem(INTERNAL_DIAGNOSTICS_STORAGE_KEY);
    return parsePersistedDiagnostics(raw);
  } catch {
    return null;
  }
}

export async function savePersistedDiagnostics(
  payload: PersistedDiagnosticsPayload,
  adapter: InternalDiagnosticsStorageAdapter = defaultAdapter
): Promise<boolean> {
  try {
    await adapter.setItem(
      INTERNAL_DIAGNOSTICS_STORAGE_KEY,
      JSON.stringify(payload)
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearPersistedDiagnostics(
  adapter: InternalDiagnosticsStorageAdapter = defaultAdapter
): Promise<boolean> {
  try {
    await adapter.removeItem(INTERNAL_DIAGNOSTICS_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serializes AsyncStorage operations so Clear always runs after any
 * already-started write and becomes the final authoritative op.
 */
export function createSerializedStorageQueue(): {
  enqueue: (op: () => Promise<void>) => Promise<void>;
  /** Wait until all enqueued ops settle (tests). */
  drain: () => Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const run = chain.then(async () => {
      try {
        await op();
      } catch {
        // best-effort
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  return {
    enqueue,
    drain: () => chain,
  };
}

export function createDiagnosticsPersistScheduler(options: {
  debounceMs?: number;
  /** Called when debounce fires; must be safe / best-effort. */
  onFlush: () => void;
  isEnabled?: () => boolean;
  schedule?: (cb: () => void, ms: number) => { cancel: () => void };
}): {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
  hasPendingTimer: () => boolean;
} {
  const debounceMs =
    options.debounceMs ?? INTERNAL_DIAGNOSTICS_PERSIST_DEBOUNCE_MS;
  const scheduleTimer =
    options.schedule ??
    ((cb, ms) => {
      const id = setTimeout(cb, ms);
      return { cancel: () => clearTimeout(id) };
    });

  let handle: { cancel: () => void } | null = null;
  let pending = false;

  const flush = () => {
    pending = false;
    if (handle) {
      handle.cancel();
      handle = null;
    }
    if (options.isEnabled && !options.isEnabled()) return;
    try {
      options.onFlush();
    } catch {
      // ignore
    }
  };

  return {
    schedule() {
      if (options.isEnabled && !options.isEnabled()) return;
      pending = true;
      if (handle) return;
      handle = scheduleTimer(() => {
        handle = null;
        if (!pending) return;
        flush();
      }, debounceMs);
    },
    flush,
    cancel() {
      pending = false;
      if (handle) {
        handle.cancel();
        handle = null;
      }
    },
    hasPendingTimer: () => handle != null || pending,
  };
}
