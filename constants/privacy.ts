/**
 * Privacy Policy URL
 * Points to Supabase Edge Function privacy-policy, which reads HTML from
 * Storage bucket=legal, path=privacy-policy.html and returns it with
 * Content-Type: text/html; charset=utf-8 (fixes iOS garbled text).
 * Override with EXPO_PUBLIC_PRIVACY_POLICY_URL if needed.
 */
export const PRIVACY_POLICY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL ||
  'https://ifgcizhnblkonbjzkfyb.supabase.co/functions/v1/privacy-policy';
