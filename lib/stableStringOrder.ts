/**
 * Locale-independent order for analytical ids.
 * UTF-16 code-unit comparison, which is code-point order for these ASCII ids.
 */
export function compareStableString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
