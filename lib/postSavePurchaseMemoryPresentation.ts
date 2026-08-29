import type { PostSavePurchaseMemory } from './postSavePurchaseMemory';
import {
  formatProductPriceAmount,
  resolveProductPriceChangePresentation,
  type ProductPriceChangePresentation,
} from './productPricePresentation';

export type PostSavePurchaseMemoryPresentation = {
  pricePresentation: ProductPriceChangePresentation | null;
  priceChangeTextKey: string | null;
  priceChangeTextParams: Record<string, string> | null;
};

export function resolvePostSavePurchaseMemoryPresentation(
  memory: PostSavePurchaseMemory
): PostSavePurchaseMemoryPresentation {
  if (!memory.priceInterpretation) {
    return {
      pricePresentation: null,
      priceChangeTextKey: null,
      priceChangeTextParams: null,
    };
  }

  const presentation = resolveProductPriceChangePresentation(
    memory.priceInterpretation
  );

  let priceChangeTextKey: string | null = null;
  let priceChangeTextParams: Record<string, string> | null = null;

  if (presentation.change) {
    priceChangeTextKey = presentation.change.key;
    if (
      presentation.change.deltaAmount != null &&
      memory.priceInterpretation.current.currency
    ) {
      priceChangeTextParams = {
        amount: formatProductPriceAmount(
          presentation.change.deltaAmount,
          memory.priceInterpretation.current.currency
        ),
      };
    }
  } else if (presentation.promo) {
    priceChangeTextKey = presentation.promo.key;
  }

  return {
    pricePresentation: presentation,
    priceChangeTextKey,
    priceChangeTextParams,
  };
}
