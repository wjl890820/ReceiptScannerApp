/**
 * Focused single-flight tests for getOrCreateInstallationId.
 */
import {
  INSTALLATION_ID_STORAGE_KEY,
  __resetInstallationIdMemoryForTests,
  __setInstallationIdGeneratorForTests,
  getOrCreateInstallationId,
  type InstallationIdStorage,
} from './installationId';

function makeMemoryStorage(initial?: string | null): InstallationIdStorage & {
  _map: Map<string, string>;
  getCalls: number;
  setCalls: number;
} {
  const map = new Map<string, string>();
  if (initial != null && initial !== '') {
    map.set(INSTALLATION_ID_STORAGE_KEY, initial);
  }
  const storage = {
    _map: map,
    getCalls: 0,
    setCalls: 0,
    getItem: async (key: string) => {
      storage.getCalls += 1;
      return map.has(key) ? map.get(key)! : null;
    },
    setItem: async (key: string, value: string) => {
      storage.setCalls += 1;
      map.set(key, value);
    },
  };
  return storage;
}

describe('getOrCreateInstallationId single-flight', () => {
  beforeEach(() => {
    __resetInstallationIdMemoryForTests();
  });

  afterEach(() => {
    __resetInstallationIdMemoryForTests();
  });

  it('A — concurrent empty-storage calls share one id, one generate, one write', async () => {
    const storage = makeMemoryStorage();
    let generateCount = 0;
    __setInstallationIdGeneratorForTests(() => {
      generateCount += 1;
      return `gen-${generateCount}`;
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => getOrCreateInstallationId(storage))
    );

    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect(results[0]).toBe('gen-1');
    expect(generateCount).toBe(1);
    expect(storage.setCalls).toBe(1);
    expect(storage._map.get(INSTALLATION_ID_STORAGE_KEY)).toBe('gen-1');
  });

  it('B — concurrent callers reuse persisted ID without generating', async () => {
    const storage = makeMemoryStorage('persisted-install-id');
    let generateCount = 0;
    __setInstallationIdGeneratorForTests(() => {
      generateCount += 1;
      return `should-not-run-${generateCount}`;
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => getOrCreateInstallationId(storage))
    );

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('persisted-install-id');
    expect(generateCount).toBe(0);
    expect(storage.setCalls).toBe(0);
  });

  it('C — failed in-flight clears; subsequent call retries successfully', async () => {
    const storage = makeMemoryStorage();
    let generateCount = 0;
    __setInstallationIdGeneratorForTests(() => {
      generateCount += 1;
      if (generateCount === 1) {
        throw new Error('generate_boom');
      }
      return 'after-retry-id';
    });

    await expect(getOrCreateInstallationId(storage)).rejects.toThrow('generate_boom');
    expect(generateCount).toBe(1);

    // In-flight must not remain poisoned
    const id = await getOrCreateInstallationId(storage);
    expect(id).toBe('after-retry-id');
    expect(generateCount).toBe(2);
    expect(storage._map.get(INSTALLATION_ID_STORAGE_KEY)).toBe('after-retry-id');
  });

  it('D — post-resolution fast path skips storage read/generation', async () => {
    const storage = makeMemoryStorage();
    let generateCount = 0;
    __setInstallationIdGeneratorForTests(() => {
      generateCount += 1;
      return 'fast-path-id';
    });

    const first = await getOrCreateInstallationId(storage);
    expect(first).toBe('fast-path-id');
    const getsAfterFirst = storage.getCalls;
    const setsAfterFirst = storage.setCalls;
    expect(generateCount).toBe(1);

    const second = await getOrCreateInstallationId(storage);
    const third = await getOrCreateInstallationId(storage);

    expect(second).toBe('fast-path-id');
    expect(third).toBe('fast-path-id');
    expect(generateCount).toBe(1);
    expect(storage.getCalls).toBe(getsAfterFirst);
    expect(storage.setCalls).toBe(setsAfterFirst);
  });
});
