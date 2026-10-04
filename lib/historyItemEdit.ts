/**
 * History item-edit save assembly.
 * Category learning is decided here; the screen performs the I/O only when
 * categoryChangedThisEdit is true. This editor does not change the item name.
 */

import {
  applyUserLineAmountEdit,
  itemAmountForAnalytics,
  type DiscountableItem,
} from './receiptDiscountAllocation';
import { applyProductIdentityToItem } from './receiptItemIdentity';
import {
  historyEditorDisplayedCategory,
  historyItemCategoryChangedThisEdit,
  materializeHistoryEditedItemCategorySemantics,
} from './reviewCategorySemantics';
import { stampUserClassificationProvenance } from './productTaxonomy';
import {
  amountCorrectionInput,
  applyItemFieldCorrections,
  categoryCorrectionInput,
  quantityCorrectionInput,
} from './userCorrections';

function round0(n: number): number {
  return Math.round(n);
}

export type HistoryItemEditInput = {
  existingItem: Record<string, unknown>;
  finalCategory: string;
  quantity: number;
  lineTotal: number;
  merchantName?: string | null;
  itemSourceIndex: number;
};

export type HistoryItemEditResult = {
  nextItem: Record<string, unknown>;
  categoryChangedThisEdit: boolean;
};

export function prepareHistoryItemEdit(input: HistoryItemEditInput): HistoryItemEditResult {
  const existingItem = input.existingItem;
  const finalCategory = input.finalCategory;
  const itemName = typeof existingItem.name === 'string' ? existingItem.name : undefined;
  const categoryChangedThisEdit = historyItemCategoryChangedThisEdit({
    storedCategory: existingItem.category,
    itemName,
    finalCategory,
  });
  const categoryBaseline = historyEditorDisplayedCategory(existingItem.category, itemName);
  const beforeQuantity = Number(existingItem.quantity);
  const beforeAmount = itemAmountForAnalytics(existingItem as DiscountableItem);
  const quantity = round0(input.quantity);
  const lineTotal = round0(input.lineTotal);
  const normalizedBeforeQuantity =
    Number.isFinite(beforeQuantity) && beforeQuantity > 0 ? beforeQuantity : 1;

  const withIdentity = applyProductIdentityToItem(
    {
      ...existingItem,
      quantity,
      category: finalCategory,
    },
    {
      finalName: itemName,
      finalCategory,
      merchantName: input.merchantName,
      classificationBrand: existingItem.brand,
      useExistingClassificationEvidence: true,
    }
  );

  let nextItem: Record<string, unknown> = {
    ...applyUserLineAmountEdit(withIdentity as DiscountableItem, lineTotal),
    ...(categoryChangedThisEdit ? stampUserClassificationProvenance() : {}),
    ...(quantity !== normalizedBeforeQuantity ? { quantityUserEdited: true } : {}),
  };

  nextItem = materializeHistoryEditedItemCategorySemantics(nextItem, {
    storedCategory: existingItem.category,
    itemName,
    finalCategory,
  });

  nextItem = applyItemFieldCorrections(nextItem, [
    quantityCorrectionInput({
      beforeQuantity: normalizedBeforeQuantity,
      afterQuantity: quantity,
      previouslyUserEdited: existingItem.quantityUserEdited === true,
      itemSourceIndex: input.itemSourceIndex,
    }),
    amountCorrectionInput({
      beforeAmount: Number.isFinite(beforeAmount) ? Math.round(beforeAmount) : 0,
      afterAmount: lineTotal,
      previouslyUserEdited: existingItem.amountUserEdited === true,
      itemSourceIndex: input.itemSourceIndex,
    }),
    categoryCorrectionInput({
      beforeCategory: categoryBaseline,
      afterCategory: finalCategory,
      beforeItem: existingItem,
      itemSourceIndex: input.itemSourceIndex,
    }),
  ]);

  return { nextItem, categoryChangedThisEdit };
}
