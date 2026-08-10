/**
 * Presentation helpers for the receipt Review screen.
 * Pure UI visibility logic — no draft/save side effects.
 */

export function normalizeRecognizedName(
  value: unknown
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Show the OCR original only when the edited name differs from recognition. */
export function shouldShowRecognizedNameHint(
  editedName: string,
  recognizedName: unknown
): boolean {
  const original = normalizeRecognizedName(recognizedName);
  if (!original) return false;
  return editedName.trim() !== original;
}

/**
 * OCR raw text / trace metadata stay behind the developer gate.
 * Feedback tags remain available to all users in a collapsed section.
 */
export function shouldShowReviewDevDetails(
  devToolsUnlocked: boolean,
  isDevBuild: boolean
): boolean {
  return Boolean(devToolsUnlocked || isDevBuild);
}
