/**
 * Separate receipt purchase quantity from package/spec counts embedded in names.
 *
 * Package markers in the product name (4個 / 10PC / 3PK) must NOT become
 * purchase quantity unless there is explicit purchase evidence such as
 * (¥108 × 3個) or a structured qty that does not merely echo the package count.
 */

import { normalizeIdentityText } from './productSpecification';

const PACKAGE_COUNT_RE =
  /(\d+)\s*(?:個|本|枚|袋|パック|pc|pcs|pk|pack)\s*(?:入)?/gi;

/** Explicit purchase qty: (¥108 × 3個) / ¥393×2 / (108 x 3) */
const EXPLICIT_PURCHASE_RE =
  /[¥￥]?\s*\d[\d,]*\s*[×xX*]\s*(\d+)\s*(?:個|本|枚|袋|パック|pc|pcs|pk|pack)?/i;

export function extractPackageCountFromName(rawName: string): number | null {
  const text = normalizeIdentityText(rawName);
  if (!text) return null;
  let found: number | null = null;
  PACKAGE_COUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PACKAGE_COUNT_RE.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) found = n;
  }
  return found;
}

export function extractExplicitPurchaseQuantity(rawName: string): number | null {
  const text = normalizeIdentityText(rawName);
  if (!text) return null;
  const m = text.match(EXPLICIT_PURCHASE_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 1000) return null;
  return n;
}

/**
 * Resolve purchase quantity for one line item.
 * Prefer explicit purchase evidence; never promote package/spec counts alone.
 */
export function resolvePurchaseQuantity(rawName: string, ocrQuantity: unknown): number {
  const explicit = extractExplicitPurchaseQuantity(rawName);
  if (explicit != null) return explicit;

  const ocr =
    typeof ocrQuantity === 'number' && Number.isFinite(ocrQuantity) && ocrQuantity > 0
      ? Math.round(ocrQuantity)
      : null;

  const pack = extractPackageCountFromName(rawName);
  if (pack != null && ocr != null && ocr === pack) {
    // OCR echoed package/spec count — treat as one purchased unit.
    return 1;
  }

  if (ocr != null && ocr >= 1) return ocr;
  return 1;
}
