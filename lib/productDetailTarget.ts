export type ProductDetailTarget =
  | { type: 'sku'; key: string }
  | { type: 'canonical'; key: string }
  | { type: 'family'; key: string }
  | { type: 'occurrence'; receiptId: string; itemId: string };

export type AggregatableProductDetailTarget = Exclude<
  ProductDetailTarget,
  { type: 'occurrence' }
>;

export type ProductDetailTargetSource = {
  skuKey?: string | null;
  canonicalProductName?: string | null;
  productFamilyKey?: string | null;
  receiptId: string;
  itemId: string;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveProductDetailTarget(
  source: ProductDetailTargetSource
): ProductDetailTarget {
  const skuKey = nonEmptyString(source.skuKey);
  if (skuKey) return { type: 'sku', key: skuKey };

  const canonical = nonEmptyString(source.canonicalProductName);
  if (canonical) return { type: 'canonical', key: canonical };

  const family = nonEmptyString(source.productFamilyKey);
  if (family) return { type: 'family', key: family };

  return {
    type: 'occurrence',
    receiptId: source.receiptId,
    itemId: source.itemId,
  };
}

export function buildProductDetailHref(
  target: AggregatableProductDetailTarget
): `/product/${AggregatableProductDetailTarget['type']}?key=${string}` {
  return `/product/${target.type}?key=${encodeURIComponent(target.key)}`;
}

/**
 * Product Detail route for aggregatable identities only.
 * Occurrence (insufficient identity) → null — never invent a target.
 */
export function buildAggregatableProductDetailHref(
  source: ProductDetailTargetSource
): `/product/${AggregatableProductDetailTarget['type']}?key=${string}` | null {
  const target = resolveProductDetailTarget(source);
  return target.type === 'occurrence' ? null : buildProductDetailHref(target);
}

/**
 * Map a persisted receipt-line object onto the shared Product Detail source
 * contract. Reads existing identity fields only (snake_case or camelCase);
 * does not call buildSkuKey or invent family/canonical from raw name.
 */
export function productDetailTargetSourceFromReceiptItem(
  item: Record<string, unknown>,
  receiptId: string,
  itemIndex: number
): ProductDetailTargetSource {
  const existingId = nonEmptyString(item.id);
  return {
    receiptId,
    itemId: existingId ?? `${receiptId}:${itemIndex}`,
    skuKey:
      nonEmptyString(item.sku_key) ?? nonEmptyString(item.skuKey),
    canonicalProductName:
      nonEmptyString(item.canonical_product_name) ??
      nonEmptyString(item.canonicalProductName),
    productFamilyKey:
      nonEmptyString(item.product_family_key) ??
      nonEmptyString(item.productFamilyKey),
  };
}

export function buildProductSearchResultHref(
  source: ProductDetailTargetSource
):
  | `/product/${AggregatableProductDetailTarget['type']}?key=${string}`
  | `/history/${string}` {
  const target = resolveProductDetailTarget(source);
  return target.type === 'occurrence'
    ? `/history/${encodeURIComponent(target.receiptId)}`
    : buildProductDetailHref(target);
}

export function parseProductDetailTarget(
  targetType: unknown,
  key: unknown
): AggregatableProductDetailTarget | null {
  if (
    targetType !== 'sku' &&
    targetType !== 'canonical' &&
    targetType !== 'family'
  ) {
    return null;
  }
  const parsedKey = nonEmptyString(Array.isArray(key) ? key[0] : key);
  return parsedKey ? { type: targetType, key: parsedKey } : null;
}
