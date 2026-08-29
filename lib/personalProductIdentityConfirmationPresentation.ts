/**
 * G4-2C — pure presentation helpers for post-save personal identity feedback.
 */

import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import type { PersonalIdentityConfirmationFeedback } from './personalProductIdentityConfirmationCoordinator';
import {
  formatProductPriceAmount,
  resolveProductPriceChangePresentation,
  type ProductPriceChangePresentation,
} from './productPricePresentation';

export type PersonalIdentityFeedbackPresentationMode =
  | 'history_unlocked'
  | 'exact_price';

export type PersonalIdentityFeedbackPresentation = {
  mode: PersonalIdentityFeedbackPresentationMode;
  pricePresentation: ProductPriceChangePresentation | null;
  priceChangeTextKey: string | null;
  priceChangeTextParams: Record<string, string> | null;
};

export function resolvePersonalIdentityFeedbackPresentation(
  feedback: PersonalIdentityConfirmationFeedback,
  interpretation?: ProductPriceChangeInterpretation & { status: 'available' }
): PersonalIdentityFeedbackPresentation {
  if (feedback.kind === 'history_unlocked') {
    return {
      mode: 'history_unlocked',
      pricePresentation: null,
      priceChangeTextKey: null,
      priceChangeTextParams: null,
    };
  }

  const sourceInterpretation = interpretation ?? feedback.interpretation;
  const presentation = resolveProductPriceChangePresentation(sourceInterpretation);

  let priceChangeTextKey: string | null = null;
  let priceChangeTextParams: Record<string, string> | null = null;

  if (presentation.change) {
    priceChangeTextKey = presentation.change.key;
    if (
      presentation.change.deltaAmount != null &&
      sourceInterpretation.current.currency
    ) {
      priceChangeTextParams = {
        amount: formatProductPriceAmount(
          presentation.change.deltaAmount,
          sourceInterpretation.current.currency
        ),
      };
    }
  } else if (presentation.promo) {
    priceChangeTextKey = presentation.promo.key;
  }

  return {
    mode: 'exact_price',
    pricePresentation: presentation,
    priceChangeTextKey,
    priceChangeTextParams,
  };
}

export function personalIdentityPromptExplanationKey(
  valueReason: 'cross_merchant_history' | 'repeat_purchase_history'
): string {
  return valueReason === 'cross_merchant_history'
    ? 'postSaveSummary.identityPrompt.explanation.crossMerchant'
    : 'postSaveSummary.identityPrompt.explanation.repeatMerchant';
}
