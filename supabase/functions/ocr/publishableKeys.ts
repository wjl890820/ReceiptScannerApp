/**
 * Hosted Edge Functions inject SUPABASE_PUBLISHABLE_KEYS as a JSON object
 * mapping key names to publishable key strings:
 * {"default":"sb_publishable_...","web":"sb_publishable_..."}
 * https://supabase.com/docs/guides/functions/secrets
 *
 * Parsing is defensive. This module does not read secret-key variables and
 * does not log key material.
 */

export type LegacyOcrKeyEnv = {
  get(name: string): string | undefined;
};

const SINGULAR_PROJECT_KEY_ENV = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_PUBLISHABLE_ANON_KEY',
] as const;

export function publishableKeyValuesFromHostedJson(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const keys: string[] = [];
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) keys.push(value);
  }
  return keys;
}

export function legacyOcrAllowedProjectApiKeys(env: LegacyOcrKeyEnv): string[] {
  const singular = SINGULAR_PROJECT_KEY_ENV.map((name) => env.get(name)).filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  return singular.concat(publishableKeyValuesFromHostedJson(env.get('SUPABASE_PUBLISHABLE_KEYS')));
}

/** Exact string match. Does not consult Authorization or secret-key env vars. */
export function legacyOcrProjectApiKeyMatches(
  apiKey: string | null | undefined,
  env: LegacyOcrKeyEnv
): boolean {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return false;
  return legacyOcrAllowedProjectApiKeys(env).some((candidate) => candidate === apiKey);
}
