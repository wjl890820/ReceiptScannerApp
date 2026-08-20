/**
 * Shared Supabase JS client for React Native / Expo.
 * Session persistence uses AsyncStorage (app sandbox; cleared on uninstall).
 * detectSessionInUrl is disabled (no browser URL session).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';

import { getSupabaseAnonKey, getSupabaseUrl, isJwtLike } from './env';

let _client: SupabaseClient | null = null;
let _appStateSubscribed = false;

function ensureAppStateAutoRefresh(client: SupabaseClient): void {
  if (_appStateSubscribed) return;
  _appStateSubscribed = true;

  // React Native: refresh while foregrounded; pause in background.
  // Single listener for the shared client (avoid duplicate AppState handlers).
  AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      void client.auth.startAutoRefresh();
    } else {
      void client.auth.stopAutoRefresh();
    }
  });
}

/**
 * Returns the shared Supabase client, or null if URL/anon key are missing/invalid.
 * Does not create a second client instance.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (_client) return _client;

  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey || !isJwtLike(anonKey)) {
    return null;
  }

  _client = createClient(url, anonKey, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });

  ensureAppStateAutoRefresh(_client);
  return _client;
}

/** Test-only: reset singleton (does not clear AsyncStorage). */
export function __resetSupabaseClientForTests(): void {
  _client = null;
  _appStateSubscribed = false;
}
