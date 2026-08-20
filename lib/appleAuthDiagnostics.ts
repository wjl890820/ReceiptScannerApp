/**
 * Phase 8 acceptance diagnostics for Apple auth (safe — no secrets).
 *
 * Distinguishes failure classes without logging:
 * - rawNonce / hashedNonce
 * - identityToken
 * - authorizationCode
 */
export type AppleAuthDiagnosticCode =
  | 'apple_credential_ok'
  | 'apple_canceled'
  | 'apple_unavailable'
  | 'missing_identity_token'
  | 'apple_provider_error'
  | 'supabase_nonce_mismatch'
  | 'supabase_audience_or_provider_misconfig'
  | 'manual_linking_disabled'
  | 'identity_already_belongs_to_other_account'
  | 'uid_changed_after_link'
  | 'link_failed'
  | 'sign_in_failed'
  | 'restore_precheck_blocked_local'
  | 'restore_precheck_blocked_outbox'
  | 'restore_failed'
  | 'unknown';

export type AppleAuthDiagnostic = {
  code: AppleAuthDiagnosticCode;
  /** Safe, non-secret detail for operators (never tokens/nonces). */
  detail?: string;
};

/** Map Protect/Restore structured statuses + provider error text → diagnostic code. */
export function classifyAppleAuthFailure(params: {
  flow: 'protect' | 'restore';
  status: string;
  errorMessage?: string | null;
}): AppleAuthDiagnostic {
  const msg = String(params.errorMessage || '').toLowerCase();
  const status = params.status;

  if (status === 'canceled') return { code: 'apple_canceled' };
  if (status === 'apple_unavailable') return { code: 'apple_unavailable', detail: status };
  if (status === 'missing_identity_token') return { code: 'missing_identity_token' };
  if (status === 'apple_identity_in_use') {
    return { code: 'identity_already_belongs_to_other_account' };
  }
  if (status === 'uid_changed') return { code: 'uid_changed_after_link' };
  if (status === 'blocked_local_data_present') {
    return { code: 'restore_precheck_blocked_local' };
  }
  if (status === 'blocked_pending_local_changes') {
    return { code: 'restore_precheck_blocked_outbox' };
  }
  if (status === 'restore_failed') return { code: 'restore_failed' };

  if (msg.includes('nonce')) {
    return { code: 'supabase_nonce_mismatch', detail: 'provider_reported_nonce_issue' };
  }
  if (
    msg.includes('audience') ||
    msg.includes('client_id') ||
    msg.includes('invalid_token') ||
    msg.includes('provider')
  ) {
    return {
      code: 'supabase_audience_or_provider_misconfig',
      detail: 'provider_or_audience_issue',
    };
  }
  if (msg.includes('manual') && msg.includes('link')) {
    return { code: 'manual_linking_disabled' };
  }
  if (
    msg.includes('already') &&
    (msg.includes('identity') || msg.includes('linked') || msg.includes('exists'))
  ) {
    return { code: 'identity_already_belongs_to_other_account' };
  }

  if (params.flow === 'protect' && (status === 'link_failed' || status === 'error')) {
    return { code: 'link_failed' };
  }
  if (params.flow === 'restore' && status === 'sign_in_failed') {
    return { code: 'sign_in_failed' };
  }
  return { code: 'unknown', detail: status };
}

/**
 * Operator note for Phase 8 real-device validation.
 * Nonce-skip is diagnostic contingency only — never default production setup.
 */
export const APPLE_NONCE_VALIDATION_NOTE =
  'Only investigate temporary nonce-verification bypass if real-device validation ' +
  'proves an upstream hosted-Auth incompatibility. Do not disable nonce checks by default.';
