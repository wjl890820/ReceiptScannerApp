/** Fail-closed Node stub for Expo / Supabase / RN during deep regression CLI. */

function fail(name) {
  return function blockedRuntimeCall() {
    throw new Error(
      `[regression:receipts:deep] blocked runtime call: ${String(name)}`
    );
  };
}

async function failAsync(name) {
  return function blockedRuntimeCallAsync() {
    throw new Error(
      `[regression:receipts:deep] blocked runtime call: ${String(name)}`
    );
  };
}

const stub = new Proxy(
  {
    // Import surface only — any call throws.
    openDatabaseAsync: fail('openDatabaseAsync'),
    Constants: {},
    default: {},
    createClient: fail('supabase.createClient'),
    getItem: fail('AsyncStorage.getItem'),
    setItem: fail('AsyncStorage.setItem'),
    digestStringAsync: fail('expo-crypto.digestStringAsync'),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === '__esModule') return true;
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      return fail(prop);
    },
  }
);

module.exports = stub;
