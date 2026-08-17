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

/** Explicit purchase qty: (¥108 × 3個) / @439 × 4 / 4個 × @439 / 数量4 × 単価439 */
const EXPLICIT_PURCHASE_RES: RegExp[] = [
  /(\d+)\s*(?:個|本|枚|袋|パック|pc|pcs|pk|pack)\s*[×xX*]\s*[@¥￥]?\s*\d[\d,]*/i,
  /[(（]?\s*[@¥￥]?\s*\d[\d,]*\s*[×xX*]\s*(\d+)\s*(?:個|本|枚|袋|パック|pc|pcs|pk|pack)?/i,
  /数量\s*(\d+)\s*[×xX*]\s*単価\s*\d[\d,]*/i,
];

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
  for (const re of EXPLICIT_PURCHASE_RES) {
    const m = text.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) return n;
  }
  return null;
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
