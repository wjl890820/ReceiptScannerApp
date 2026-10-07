/**
 * Distinguish authoritative purchase total from payment/tender allocations.
 * Never invent total from a single payment field without strong evidence.
 */

export type PaymentAllocationLine = {
  label: string;
  amount: number;
};

function toHalfWidthLower(s: string): string {
  return (s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

/** Authoritative purchase-total labels — never treat as tender. */
const AUTHORITATIVE_TOTAL_MARKERS = [
  'お買上計',
  'お買上げ計',
  'お買い上げ計',
  '支払合計',
  '合計金額',
  'ご請求額',
  'grand total',
];

/** Prepaid-card tender. Must be its own token so パプリカ stays merchandise. */
const PURICA_PAYMENT_TOKEN = 'プリカ';

/**
 * `プリカ` only when it is a standalone tender token.
 * Splits on whitespace and tender punctuation. No lookbehind (Hermes).
 * `パプリカ` contains the same kana and must not match.
 */
function hasPuricaPaymentToken(name: string): boolean {
  if (!name.includes(PURICA_PAYMENT_TOKEN)) return false;
  const tokens = name.split(/[\s/／・･]+/);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === PURICA_PAYMENT_TOKEN) return true;
  }
  return false;
}

const QUO_PAYMENT_SUFFIXES = ['支払', 'カード', 'カード支払'];

/**
 * QUO card tender. Latin `quo` and kana `クオ` must be their own token
 * so liquor / Quorn / クオーツ stay merchandise.
 * Glued forms seen in production copy, such as クオ支払, stay payment.
 */
function hasQuoPaymentToken(name: string): boolean {
  const tokens = name.split(/[\s/／・･]+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'quo' || token === 'クオ') return true;
    if (!token.startsWith('クオ') || token.length === 'クオ'.length) continue;
    const rest = token.slice('クオ'.length);
    if (QUO_PAYMENT_SUFFIXES.indexOf(rest) !== -1) return true;
  }
  return false;
}

/**
 * Payment / tender allocation lines (cash, prepaid, card charge, etc.).
 * Deposits/balances alone are excluded — they are not settlement tenders.
 */
export function isPaymentAllocationLabel(name: string): boolean {
  const n = toHalfWidthLower(name);
  if (!n) return false;
  // Authoritative totals win over payment keywords (e.g. 支払合計).
  if (AUTHORITATIVE_TOTAL_MARKERS.some((m) => n.includes(toHalfWidthLower(m)))) {
    return false;
  }
  // Bare purchase-total rows are not tenders.
  if (
    (n.includes('合計') || n.includes('総計') || n === 'total' || n.includes('subtotal')) &&
    !n.includes('カード支払') &&
    !hasPuricaPaymentToken(n) &&
    !hasQuoPaymentToken(n) &&
    !/リワード|現金|クレジット|電子マネー/.test(n)
  ) {
    return false;
  }
  // Deposit / balance only (QUO 預り / 残高) — not a settlement tender.
  if (
    (n.includes('預り') || n.includes('あずかり') || n.includes('残高') || n.includes('balance')) &&
    !n.includes('支払')
  ) {
    return false;
  }
  return (
    hasPuricaPaymentToken(n) ||
    hasQuoPaymentToken(n) ||
    [
      '現金',
      'クレジット',
      'リワード',
      'カード支払',
      '電子マネー',
      'paypay',
      'aupay',
      '楽天pay',
      'waon',
      'nanaco',
      'edy',
      'id支払',
      '交通系',
    ].some((k) => n.includes(k))
  );
}

/**
 * Recover purchase total when OCR mistakenly copied a tender amount.
 *
 * Safe when:
 * - current total fails to reconcile with merchandise (items + discounts)
 * - ≥2 settlement tenders sum to merchandise
 * - current total equals one of those tenders
 *
 * Otherwise keep printed/OCR total (including QUO cases where total == payment).
 */
export function resolveAuthoritativeReceiptTotal(input: {
  ocrTotal: number | null | undefined;
  itemsPositiveSum: number;
  discountsSum: number;
  payments: PaymentAllocationLine[];
  toleranceJpy?: number;
}): number {
  const tol = input.toleranceJpy ?? 2;
  const ocr =
    typeof input.ocrTotal === 'number' && Number.isFinite(input.ocrTotal)
      ? Math.round(input.ocrTotal)
      : 0;
  const merchandise = Math.round(input.itemsPositiveSum + input.discountsSum);
  const payments = (input.payments || [])
    .map((p) => ({
      label: p.label,
      amount: Math.round(Number(p.amount)),
    }))
    .filter((p) => Number.isFinite(p.amount) && p.amount > 0);

  // Already consistent with merchandise (incl-tax style) — keep.
  if (ocr > 0 && Math.abs(merchandise - ocr) <= tol) {
    return ocr;
  }

  if (payments.length >= 2 && merchandise > 0) {
    const paySum = payments.reduce((s, p) => s + p.amount, 0);
    const ocrIsOneTender = payments.some((p) => Math.abs(p.amount - ocr) <= tol);
    if (Math.abs(paySum - merchandise) <= tol && ocrIsOneTender) {
      return merchandise;
    }
  }

  // No strong evidence to override — keep OCR total (may be 0 / unknown).
  return ocr;
}
