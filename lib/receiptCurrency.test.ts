import {
  isTrustedReceiptCurrency,
  normalizeReceiptCurrency,
  RECEIPT_TRUSTED_CURRENCY_CODES,
} from './receiptCurrency';

describe('receiptCurrency', () => {
  it('allowlists only established trusted codes', () => {
    expect(RECEIPT_TRUSTED_CURRENCY_CODES).toEqual(['JPY', 'USD']);
  });

  it('normalizes known codes and yen symbols', () => {
    expect(normalizeReceiptCurrency('jpy')).toBe('JPY');
    expect(normalizeReceiptCurrency('USD')).toBe('USD');
    expect(normalizeReceiptCurrency('¥')).toBe('JPY');
    expect(normalizeReceiptCurrency('￥')).toBe('JPY');
  });

  it('rejects blank / unknown / malformed / unsupported', () => {
    expect(normalizeReceiptCurrency(null)).toBeNull();
    expect(normalizeReceiptCurrency('')).toBeNull();
    expect(normalizeReceiptCurrency('   ')).toBeNull();
    expect(normalizeReceiptCurrency('UNKNOWN')).toBeNull();
    expect(normalizeReceiptCurrency('???')).toBeNull();
    expect(normalizeReceiptCurrency('XYZ')).toBeNull();
    expect(normalizeReceiptCurrency(123)).toBeNull();
    expect(isTrustedReceiptCurrency('???')).toBe(false);
  });
});
