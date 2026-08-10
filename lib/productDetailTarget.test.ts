import {
  buildProductDetailHref,
  buildProductSearchResultHref,
  parseProductDetailTarget,
  resolveProductDetailTarget,
} from './productDetailTarget';

describe('resolveProductDetailTarget', () => {
  const occurrence = { receiptId: 'receipt-1', itemId: 'receipt-1:0' };

  it('uses sku, canonical, family, then occurrence priority', () => {
    expect(
      resolveProductDetailTarget({
        ...occurrence,
        skuKey: 'sku-900',
        canonicalProductName: '明治 おいしい牛乳',
        productFamilyKey: 'milk',
      })
    ).toEqual({ type: 'sku', key: 'sku-900' });
    expect(
      resolveProductDetailTarget({
        ...occurrence,
        canonicalProductName: '明治 おいしい牛乳',
        productFamilyKey: 'milk',
      })
    ).toEqual({ type: 'canonical', key: '明治 おいしい牛乳' });
    expect(
      resolveProductDetailTarget({
        ...occurrence,
        productFamilyKey: 'milk',
      })
    ).toEqual({ type: 'family', key: 'milk' });
    expect(resolveProductDetailTarget(occurrence)).toEqual({
      type: 'occurrence',
      ...occurrence,
    });
  });

  it('never promotes normalized names to canonical targets', () => {
    expect(
      resolveProductDetailTarget({
        ...occurrence,
        canonicalProductName: null,
        productFamilyKey: null,
      })
    ).toEqual({ type: 'occurrence', ...occurrence });
  });
});

describe('Product Detail route safety', () => {
  it('round-trips Japanese canonical keys without putting JSON in the URL', () => {
    const target = { type: 'canonical' as const, key: '明治 おいしい牛乳 900ml/特売' };
    const href = buildProductDetailHref(target);
    const url = new URL(href, 'https://receipt.local');

    expect(url.pathname).toBe('/product/canonical');
    expect(url.searchParams.get('key')).toBe(target.key);
    expect(parseProductDetailTarget('canonical', url.searchParams.get('key'))).toEqual(
      target
    );
    expect(href).not.toContain('{');
  });

  it('routes credible search identities to Product Detail and occurrence fallback to receipt', () => {
    expect(
      buildProductSearchResultHref({
        receiptId: 'receipt-1',
        itemId: 'receipt-1:0',
        productFamilyKey: 'milk',
      })
    ).toBe('/product/family?key=milk');
    expect(
      buildProductSearchResultHref({
        receiptId: 'receipt / 1',
        itemId: 'receipt-1:0',
      })
    ).toBe('/history/receipt%20%2F%201');
  });
});
