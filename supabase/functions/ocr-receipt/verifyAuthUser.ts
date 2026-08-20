/**
 * Authoritative Supabase Auth user resolution for Edge OCR.
 *
 * Security boundary: service_role writes to ocr_runs MUST only use a user_id
 * returned by Supabase Auth verification (getUser / equivalent).
 *
 * NEVER decode the JWT payload and trust `sub` without verification.
 */

export type VerifiedAuthUser = {
  id: string;
};

export type GetUserFnResult = {
  data: { user: VerifiedAuthUser | null };
  error: { message?: string } | null;
};

export type ResolveVerifiedUserIdParams = {
  bearerToken: string;
  /** Must call Supabase Auth getUser(jwt) or equivalent — not local JWT decode. */
  verifyWithSupabaseAuth: (jwt: string) => Promise<GetUserFnResult>;
};

function isJwtShape(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * Resolve a verified user id from an Authorization bearer token.
 * Returns null for missing/invalid/unverified tokens (legacy Build 34 path).
 */
export async function resolveVerifiedUserId(
  params: ResolveVerifiedUserIdParams
): Promise<string | null> {
  const token = typeof params.bearerToken === 'string' ? params.bearerToken.trim() : '';
  if (!token || !isJwtShape(token)) {
    return null;
  }

  try {
    const { data, error } = await params.verifyWithSupabaseAuth(token);
    if (error || !data?.user?.id) {
      return null;
    }
    return data.user.id;
  } catch {
    return null;
  }
}
