/**
 * Legacy `ocr` remains reachable when ocr-receipt returns 404.
 * Hosted functions receive SUPABASE_PUBLISHABLE_KEYS as a JSON name-to-key object.
 * Anonymous acceptance is apikey equality and does not require Authorization.
 */
import fs from 'fs';
import path from 'path';

import {
  legacyOcrProjectApiKeyMatches,
  publishableKeyValuesFromHostedJson,
  type LegacyOcrKeyEnv,
} from '../supabase/functions/ocr/publishableKeys';

const KEY_A = `sb_publishable_${'A'.repeat(10)}-${'B'.repeat(11)}_${'c'.repeat(8)}`;
const KEY_B = `sb_publishable_${'C'.repeat(10)}_${'D'.repeat(11)}_${'e'.repeat(8)}`;
const ANON = 'legacy-anon-key-value';

function envOf(values: Record<string, string | undefined>): LegacyOcrKeyEnv {
  return {
    get(name: string) {
      return values[name];
    },
  };
}

describe('legacy ocr hosted publishable keys', () => {
  it('accepts one hosted publishable key by exact equality', () => {
    const raw = JSON.stringify({ default: KEY_A });
    expect(publishableKeyValuesFromHostedJson(raw)).toEqual([KEY_A]);
    expect(
      legacyOcrProjectApiKeyMatches(KEY_A, envOf({ SUPABASE_PUBLISHABLE_KEYS: raw }))
    ).toBe(true);
  });

  it('accepts each string value when several hosted keys are present', () => {
    const raw = JSON.stringify({ default: KEY_A, mobile: KEY_B });
    const env = envOf({ SUPABASE_PUBLISHABLE_KEYS: raw });
    expect(legacyOcrProjectApiKeyMatches(KEY_A, env)).toBe(true);
    expect(legacyOcrProjectApiKeyMatches(KEY_B, env)).toBe(true);
    expect(legacyOcrProjectApiKeyMatches(`${KEY_A} `, env)).toBe(false);
  });

  it('rejects an apikey that is not in the hosted set', () => {
    const env = envOf({ SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: KEY_A }) });
    expect(legacyOcrProjectApiKeyMatches(KEY_B, env)).toBe(false);
    expect(legacyOcrProjectApiKeyMatches(null, env)).toBe(false);
  });

  it('ignores malformed JSON without throwing', () => {
    expect(publishableKeyValuesFromHostedJson('{')).toEqual([]);
    expect(publishableKeyValuesFromHostedJson('')).toEqual([]);
    expect(publishableKeyValuesFromHostedJson(undefined)).toEqual([]);
    expect(publishableKeyValuesFromHostedJson('   ')).toEqual([]);
    expect(publishableKeyValuesFromHostedJson('null')).toEqual([]);
    expect(publishableKeyValuesFromHostedJson('["not-an-object"]')).toEqual([]);
    expect(() =>
      legacyOcrProjectApiKeyMatches(KEY_A, envOf({ SUPABASE_PUBLISHABLE_KEYS: '{' }))
    ).not.toThrow();
    expect(
      legacyOcrProjectApiKeyMatches(KEY_A, envOf({ SUPABASE_PUBLISHABLE_KEYS: '{' }))
    ).toBe(false);
  });

  it('ignores non-string hosted values and secret-key env vars', () => {
    const raw = JSON.stringify({
      default: KEY_A,
      count: 1,
      empty: '',
      nested: { key: KEY_B },
      missing: null,
    });
    expect(publishableKeyValuesFromHostedJson(raw)).toEqual([KEY_A]);
    const env = envOf({
      SUPABASE_PUBLISHABLE_KEYS: raw,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_hosted' }),
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
    });
    expect(legacyOcrProjectApiKeyMatches('sb_secret_hosted', env)).toBe(false);
    expect(legacyOcrProjectApiKeyMatches('service-role-value', env)).toBe(false);
    expect(legacyOcrProjectApiKeyMatches(KEY_B, env)).toBe(false);
  });

  it('preserves singular project-key env matches', () => {
    expect(
      legacyOcrProjectApiKeyMatches(ANON, envOf({ SUPABASE_ANON_KEY: ANON }))
    ).toBe(true);
    expect(
      legacyOcrProjectApiKeyMatches(KEY_A, envOf({ SUPABASE_PUBLISHABLE_KEY: KEY_A }))
    ).toBe(true);
    expect(
      legacyOcrProjectApiKeyMatches(KEY_B, envOf({ SUPABASE_PUBLISHABLE_ANON_KEY: KEY_B }))
    ).toBe(true);
  });

  it('matches an anonymous apikey without an Authorization input', () => {
    const matched = legacyOcrProjectApiKeyMatches(
      KEY_A,
      envOf({ SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: KEY_A }) })
    );
    expect(matched).toBe(true);
    const source = fs.readFileSync(
      path.join(__dirname, '../supabase/functions/ocr/index.ts'),
      'utf8'
    );
    expect(source).toContain('legacyOcrProjectApiKeyMatches(apiKey, Deno.env)');
    expect(source).toContain('if (bearerToken)');
    expect(source).not.toContain('SUPABASE_SECRET_KEYS');
  });
});
