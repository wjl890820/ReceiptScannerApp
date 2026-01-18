/**
 * Privacy Policy URL
 * This URL should point to the hosted privacy policy page in Supabase Storage
 * Format: https://<project-ref>.supabase.co/storage/v1/object/public/legal/privacy-policy.html
 * 
 * After uploading privacy-policy.html to Supabase Storage, update this constant.
 */
export const PRIVACY_POLICY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL ||
  'https://ifgcizhnblkonbjzkfyb.supabase.co/storage/v1/object/public/legal/privacy-policy.html';
