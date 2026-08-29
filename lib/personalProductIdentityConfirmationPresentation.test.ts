import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import {
  personalIdentityPromptExplanationKey,
  resolvePersonalIdentityFeedbackPresentation,
} from './personalProductIdentityConfirmationPresentation';

function availableInterpretation(
  overrides: Partial<Extract<ProductPriceChangeInterpretation, { status: 'available' }>> = {}
): Extract<ProductPriceChangeInterpretation, { status: 'available' }> {
  return {
    status: 'available',
    identityAuthority: {
      kind: 'personal_product',
      anchorMerchantProductId: 'mp-a',
      memberMerchantProductIds: ['mp-a', 'mp-b'],
    },
    previous: {
      receiptId: 'r1',
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
      receiptId: 'r2',
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
    ...overrides,
  };
}

describe('G4-2C personalProductIdentityConfirmationPresentation', () => {
  it('history_unlocked uses safe history mode without exact delta', () => {
    const presentation = resolvePersonalIdentityFeedbackPresentation({
      kind: 'history_unlocked',
      target: { type: 'personal_product', key: 'mp-a' },
      purchaseOccurrenceCount: 2,
      merchantCount: 2,
    });
    expect(presentation.mode).toBe('history_unlocked');
    expect(presentation.pricePresentation).toBeNull();
    expect(presentation.priceChangeTextKey).toBeNull();
  });

  it('exact_price uses existing G3 presentation for decreased prices', () => {
    const interpretation = availableInterpretation();
    const presentation = resolvePersonalIdentityFeedbackPresentation({
      kind: 'exact_price',
      target: { type: 'personal_product', key: 'mp-a' },
      purchaseOccurrenceCount: 2,
      merchantCount: 2,
      interpretation,
    });
    expect(presentation.mode).toBe('exact_price');
    expect(presentation.priceChangeTextKey).toBe('priceHistory.change.decreased');
    expect(presentation.priceChangeTextParams).toEqual({ amount: '¥30' });
  });

  it('exact_price preserves promo ended semantics', () => {
    const interpretation = availableInterpretation({
      grossDirection: 'unchanged',
      grossDelta: 0,
      promoTransition: 'ended',
      previousPromo: 'explicit_discount',
      currentPromo: 'none_observed',
    });
    const presentation = resolvePersonalIdentityFeedbackPresentation({
      kind: 'exact_price',
      target: { type: 'personal_product', key: 'mp-a' },
      purchaseOccurrenceCount: 2,
      merchantCount: 2,
      interpretation,
    });
    expect(presentation.pricePresentation?.promo?.key).toBe('priceHistory.promo.ended');
  });

  it('prompt explanation key distinguishes cross-merchant and repeat merchant', () => {
    expect(personalIdentityPromptExplanationKey('cross_merchant_history')).toBe(
      'postSaveSummary.identityPrompt.explanation.crossMerchant'
    );
    expect(personalIdentityPromptExplanationKey('repeat_purchase_history')).toBe(
      'postSaveSummary.identityPrompt.explanation.repeatMerchant'
    );
  });
});
