/**
 * Separate receipt purchase quantity from package/spec counts embedded in names.
 *
 * Package markers in the product name (4個 / 10PC / 3PK) must NOT become
 * purchase quantity unless there is explicit purchase evidence such as
 * (¥108 × 3個), 2個 × 単108, or a structured qty that does not merely echo
 * the package count.
 */

import { normalizeIdentityText } from './productSpecification';

const PACKAGE_COUNT_RE =
  /(\d+)\s*(?:個|本|枚|袋|パック|pc|pcs|pk|pack)\s*(?:入)?/gi;

/** Purchase counters allowed in explicit multiplier evidence. */
const PURCHASE_COUNTER =
  '(?:個|コ|点|本|枚|袋|パック|箱|pc|pcs|pk|pack)';

/**
 * Price-shaped RHS for qty-first multipliers.
 * Requires 単 / 単価 / @ / ¥ / ￥ / 円 — not bare numbers (avoids 2 × 500ml).
 */
const PRICE_RHS =
  '(?:単価\\s*\\d[\\d,]*|単\\s*\\d[\\d,]*|[@¥￥]\\s*\\d[\\d,]*|\\d[\\d,]*\\s*円)';

/** Multiplication operators (NFKC maps ＊ → *). */
const MULT_OP = '[×xX*]';

/**
 * Explicit purchase qty evidence (first match wins):
 * - qty-first: 2個 × 単108 / 2 × ¥108 / 3点×108円 / 2本＊単価150
 * - qty @ price: 3個 @108円
 * - price-first: (¥108 × 3個) / @439 × 4
 * - 数量 N × 単価 N
 */
const EXPLICIT_PURCHASE_RES: RegExp[] = [
  // N [counter]? ×|* price-shaped
  new RegExp(
    `(\\d+)\\s*(?:${PURCHASE_COUNTER})?\\s*${MULT_OP}\\s*${PRICE_RHS}`,
    'i'
  ),
  // N counter @ price (3個 @108円) — @ as operator; counter required
  new RegExp(
    `(\\d+)\\s*${PURCHASE_COUNTER}\\s*@\\s*(?:単価\\s*)?\\d[\\d,]*(?:\\s*円)?`,
    'i'
  ),
  // price-first: require currency/単 marker on the price side
  new RegExp(
    `[(（]?\\s*(?:[@¥￥]|単価\\s*|単\\s*)\\d[\\d,]*\\s*${MULT_OP}\\s*(\\d+)\\s*(?:${PURCHASE_COUNTER})?`,
    'i'
  ),
  // 数量 N × 単価 N
  new RegExp(`数量\\s*(\\d+)\\s*${MULT_OP}\\s*単価\\s*\\d[\\d,]*`, 'i'),
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
