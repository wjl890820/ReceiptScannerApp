/**
 * Privacy redaction for regression reports / console.
 */

const SENSITIVE_KEYS = new Set([
  'user_id',
  'installation_id',
  'access_token',
  'refresh_token',
  'authorization',
  'auth_token',
  'identityToken',
  'SERVICE_ROLE',
]);

/** Strip sensitive keys recursively. Redact full local image paths. */
export function redactForReport<T>(value: T): T {
  return redactInner(value) as T;
}

function redactInner(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactInner);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      if (k === 'image_uri' || k === 'imageUri' || k === 'path') {
        if (typeof v === 'string' && v.trim()) {
          out[k] = v.startsWith('file:') || v.includes('/var/') || v.includes('ImagePicker')
            ? '[redacted_local_path]'
            : v.length > 48
              ? '[redacted_path]'
              : v;
          continue;
        }
      }
      out[k] = redactInner(v);
    }
    return out;
  }
  return value;
}

/** True if a plain object still contains banned keys (for tests). */
export function containsSensitiveKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKeys);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) return true;
      if (containsSensitiveKeys(v)) return true;
    }
  }
  return false;
}
