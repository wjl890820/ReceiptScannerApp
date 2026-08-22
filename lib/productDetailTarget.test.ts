import {
  buildAggregatableProductDetailHref,
  buildProductDetailHref,
  buildProductSearchResultHref,
  parseProductDetailTarget,
  productDetailTargetSourceFromReceiptItem,
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

describe('Receipt Detail → Product Detail affordance (R2-B1)', () => {
  it('reuses the same aggregatable href contract as Home/History-search', () => {
    const source = {
      receiptId: 'receipt-1',
      itemId: 'receipt-1:0',
      skuKey: 'sku-900',
      canonicalProductName: '明治 おいしい牛乳',
      productFamilyKey: 'milk',
    };
    expect(buildAggregatableProductDetailHref(source)).toBe(
      buildProductDetailHref({ type: 'sku', key: 'sku-900' })
    );
    expect(buildAggregatableProductDetailHref(source)).toBe(
      buildProductSearchResultHref(source)
    );

    const familyOnly = {
      receiptId: 'receipt-1',
      itemId: 'receipt-1:0',
      productFamilyKey: 'milk',
    };
    expect(buildAggregatableProductDetailHref(familyOnly)).toBe(
      '/product/family?key=milk'
    );
    expect(buildAggregatableProductDetailHref(familyOnly)).toBe(
      buildProductSearchResultHref(familyOnly)
    );
  });

  it('returns null for unresolved identity instead of inventing a Product Detail route', () => {
    expect(
      buildAggregatableProductDetailHref({
        receiptId: 'receipt-1',
        itemId: 'receipt-1:0',
      })
    ).toBeNull();
    expect(
      buildAggregatableProductDetailHref({
        receiptId: 'receipt-1',
        itemId: 'receipt-1:0',
        canonicalProductName: '   ',
        productFamilyKey: null,
        skuKey: undefined,
      })
    ).toBeNull();
  });

  it('maps receipt-item JSON fields without inventing identity from raw name', () => {
    expect(
      productDetailTargetSourceFromReceiptItem(
        {
          name: '何かの商品',
          canonical_product_name: '明治 おいしい牛乳',
          product_family_key: 'milk',
          sku_key: 'sku-900',
        },
        'receipt-1',
        2
      )
    ).toEqual({
      receiptId: 'receipt-1',
      itemId: 'receipt-1:2',
      skuKey: 'sku-900',
      canonicalProductName: '明治 おいしい牛乳',
      productFamilyKey: 'milk',
    });

    const unresolved = productDetailTargetSourceFromReceiptItem(
      { name: '未知の商品だけ' },
      'receipt-1',
      0
    );
    expect(unresolved).toEqual({
      receiptId: 'receipt-1',
      itemId: 'receipt-1:0',
      skuKey: null,
      canonicalProductName: null,
      productFamilyKey: null,
    });
    expect(buildAggregatableProductDetailHref(unresolved)).toBeNull();
  });

  it('does not replace edit semantics — href builder is independent of row-edit open', () => {
    // Edit remains a separate Pressable onPress(openItemEditor); this helper
    // only produces optional navigation hrefs and never mutates item fields.
    const source = productDetailTargetSourceFromReceiptItem(
      {
        name: '牛乳',
        product_family_key: 'milk',
        quantity: 1,
        lineTotal: 198,
      },
      'r1',
      0
    );
    expect(buildAggregatableProductDetailHref(source)).toBe(
      '/product/family?key=milk'
    );
    expect(source).toMatchObject({
      receiptId: 'r1',
      itemId: 'r1:0',
      productFamilyKey: 'milk',
    });
  });
});
