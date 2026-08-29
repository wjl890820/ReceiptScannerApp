import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import type { PostSavePurchaseMemory } from './postSavePurchaseMemory';
import { resolvePostSavePurchaseMemoryPresentation } from './postSavePurchaseMemoryPresentation';

function memory(
  overrides: Partial<PostSavePurchaseMemory> = {}
): PostSavePurchaseMemory {
  return {
    savedReceiptId: 'r-current',
    target: { type: 'merchant_product', key: 'mp-1' },
    identityKind: 'merchant_product',
    displayName: 'Coke',
    purchaseOccurrenceCount: 2,
    previousPurchase: {
      receiptId: 'r-old',
      occurredAt: 1,
      merchantName: 'Lawson',
    },
    merchantCount: 1,
    priceInterpretation: null,
    ...overrides,
  };
}

describe('G5-1 postSavePurchaseMemoryPresentation', () => {
  it('shows repeat facts only when price interpretation is absent', () => {
    const presentation = resolvePostSavePurchaseMemoryPresentation(memory());
    expect(presentation.pricePresentation).toBeNull();
    expect(presentation.priceChangeTextKey).toBeNull();
  });

  it('uses existing G3 presentation when interpretation is available', () => {
    const interpretation: ProductPriceChangeInterpretation & { status: 'available' } = {
      status: 'available',
      identityAuthority: { kind: 'sku', skuKey: 'sku-1' },
      previous: {
        receiptId: 'r-old',
        occurredAt: 1,
        priceValue: 150,
        grossLineAmount: 150,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'purchase_unit',
        amountBasis: 'tax_included',
        promoContext: 'none_observed',
        promoState: 'none_observed',
        discountAllocated: 0,
        effectiveLineAmount: 150,
      },
      current: {
        receiptId: 'r-current',
        occurredAt: 2,
        priceValue: 120,
        grossLineAmount: 120,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'purchase_unit',
        amountBasis: 'tax_included',
        promoContext: 'none_observed',
        promoState: 'none_observed',
        discountAllocated: 0,
        effectiveLineAmount: 120,
      },
      grossDirection: 'decreased',
      grossDelta: -30,
      promoTransition: 'none',
      previousPromo: 'none_observed',
      currentPromo: 'none_observed',
      previousDiscountAllocated: 0,
      currentDiscountAllocated: 0,
    };
    const presentation = resolvePostSavePurchaseMemoryPresentation(
      memory({ priceInterpretation: interpretation })
    );
    expect(presentation.priceChangeTextKey).toBe('priceHistory.change.decreased');
    expect(presentation.priceChangeTextParams).toEqual({ amount: '¥30' });
  });

  it('preserves promo ended semantics from G3 presentation', () => {
    const interpretation: ProductPriceChangeInterpretation & { status: 'available' } = {
      status: 'available',
      identityAuthority: { kind: 'sku', skuKey: 'sku-1' },
      previous: {
        receiptId: 'r-old',
        occurredAt: 1,
        priceValue: 150,
        grossLineAmount: 150,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'purchase_unit',
        amountBasis: 'tax_included',
        promoContext: 'explicit_discount',
        promoState: 'explicit_discount',
        discountAllocated: -10,
        effectiveLineAmount: 140,
      },
      current: {
        receiptId: 'r-current',
        occurredAt: 2,
        priceValue: 150,
        grossLineAmount: 150,
        purchaseQuantity: 1,
        currency: 'JPY',
        priceKind: 'purchase_unit',
        amountBasis: 'tax_included',
        promoContext: 'none_observed',
        promoState: 'none_observed',
        discountAllocated: 0,
        effectiveLineAmount: 150,
      },
      grossDirection: 'unchanged',
      grossDelta: 0,
      promoTransition: 'ended',
      previousPromo: 'explicit_discount',
      currentPromo: 'none_observed',
      previousDiscountAllocated: -10,
      currentDiscountAllocated: 0,
    };
    const presentation = resolvePostSavePurchaseMemoryPresentation(
      memory({ priceInterpretation: interpretation })
    );
    expect(presentation.pricePresentation?.promo?.key).toBe('priceHistory.promo.ended');
  });
});
