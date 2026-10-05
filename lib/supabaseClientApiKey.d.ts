/** Project API key check. JWT role is read from an unverified payload. */
export function isSupportedSupabaseClientApiKey(key: string | null | undefined): boolean;

/**
 * Returns undefined, null, or exact '' unchanged.
 * Throws when a present value is not a supported client key, including whitespace.
 */
export function embeddableSupabaseClientApiKey<T>(raw: T): T;

/**
 * Expo extra key selection used by app.config.js.
 * A whitespace-only or otherwise unsafe value throws without echoing it.
 */
export function configuredExpoSupabaseAnonKey(
  env:
    | {
        EXPO_PUBLIC_SUPABASE_ANON_KEY?: string | null;
        SUPABASE_ANON_KEY?: string | null;
      }
    | null
    | undefined
): string | null | undefined;

/** Test seam. Returns null when the payload is not strict base64url JSON. */
export function decodeUnverifiedJwtPayload(token: string): Record<string, unknown> | null;
