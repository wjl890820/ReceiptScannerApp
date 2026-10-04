import { prepareHistoryItemEdit } from './historyItemEdit';
import {
  historyEditorDisplayedCategory,
  historyItemCategoryChangedThisEdit,
} from './reviewCategorySemantics';
import { stampUserClassificationProvenance } from './productTaxonomy';
import { buildUserCorrectionEvent, readUserCorrections } from './userCorrections';

const RICH_PRODUCE_TAGS = [
  'ingredient',
  'cooking_related',
  'vegetable_source',
  'bulk_purchase_candidate',
];

function storedItem(overrides: Record<string, unknown> = {}) {
  return {
    name: 'sample spice',
    category: 'snacks_drinks',
    quantity: 1,
    lineTotal: 100,
    classification_source: 'rules',
    classification_version: 'rules-v9',
    taxonomy_version: 'meruno-taxonomy-v1',
    ...overrides,
  };
}

function edit(
  item: Record<string, unknown>,
  overrides: Partial<{
    finalCategory: string;
    quantity: number;
    lineTotal: number;
  }> = {}
) {
  const itemName = typeof item.name === 'string' ? item.name : undefined;
  return prepareHistoryItemEdit({
    existingItem: item,
    finalCategory:
      overrides.finalCategory ?? historyEditorDisplayedCategory(item.category, itemName),
    quantity: overrides.quantity ?? Number(item.quantity),
    lineTotal: overrides.lineTotal ?? Number(item.lineTotal),
    merchantName: '合成商店',
    itemSourceIndex: 0,
  });
}

function fields(item: Record<string, unknown>): string[] {
  return readUserCorrections(item).map((event) => event.field);
}

describe('history item edit category learning gate', () => {
  it('quantity-only saves the quantity and does not confirm the category', () => {
    const saved = edit(storedItem(), { quantity: 3 });

    expect(saved.categoryChangedThisEdit).toBe(false);
    expect(saved.nextItem.quantity).toBe(3);
    expect(saved.nextItem.category).toBe('snacks_drinks');
    expect(saved.nextItem.classification_source).toBe('rules');
    expect(saved.nextItem.classification_version).toBe('rules-v9');
    expect(saved.nextItem.quantityUserEdited).toBe(true);
    expect(fields(saved.nextItem)).toEqual(['item_quantity']);
    expect(fields(saved.nextItem)).not.toContain('item_category');
  });

  it('amount-only saves the amount and does not confirm the category', () => {
    const saved = edit(storedItem(), { lineTotal: 180 });

    expect(saved.categoryChangedThisEdit).toBe(false);
    expect(saved.nextItem.lineTotal).toBe(180);
    expect(saved.nextItem.category).toBe('snacks_drinks');
    expect(saved.nextItem.classification_source).toBe('rules');
    expect(saved.nextItem.classification_version).toBe('rules-v9');
    expect(fields(saved.nextItem)).toEqual(['item_amount']);
    expect(fields(saved.nextItem)).not.toContain('item_category');
  });

  it('stamps user provenance and records a category correction when the category changes', () => {
    const saved = edit(storedItem(), { finalCategory: 'household' });
    const userStamp = stampUserClassificationProvenance();

    expect(saved.categoryChangedThisEdit).toBe(true);
    expect(saved.nextItem.category).toBe('household');
    expect(saved.nextItem.classification_source).toBe(userStamp.classification_source);
    expect(saved.nextItem.classification_version).toBe(userStamp.classification_version);
    expect(saved.nextItem.taxonomy_version).toBe(userStamp.taxonomy_version);
    const categoryEvent = readUserCorrections(saved.nextItem).find(
      (event) => event.field === 'item_category'
    );
    expect(categoryEvent).toMatchObject({
      field: 'item_category',
      originalValue: 'snacks_drinks',
      correctedValue: 'household',
    });
    expect(fields(saved.nextItem)).not.toContain('item_quantity');
  });

  it('learns the category on a quantity edit only because the category also changed', () => {
    const saved = edit(storedItem(), { quantity: 4, finalCategory: 'household' });

    expect(saved.categoryChangedThisEdit).toBe(true);
    expect(saved.nextItem.quantity).toBe(4);
    expect(saved.nextItem.category).toBe('household');
    expect(saved.nextItem.classification_source).toBe('user');
    expect(fields(saved.nextItem)).toEqual(
      expect.arrayContaining(['item_quantity', 'item_category'])
    );
  });

  it('does not open a new category edit when quantity changes after an older category correction', () => {
    const prior = buildUserCorrectionEvent({
      field: 'item_category',
      originalValue: 'snacks_drinks',
      correctedValue: 'food_ingredients',
      originalSource: 'machine',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const saved = edit(
      storedItem({
        category: 'food_ingredients',
        classification_source: 'user',
        classification_version: 'kept-from-prior-edit',
        user_corrections: [prior],
      }),
      { quantity: 2, finalCategory: 'food_ingredients' }
    );
    const categoryEvents = readUserCorrections(saved.nextItem).filter(
      (event) => event.field === 'item_category'
    );

    expect(saved.categoryChangedThisEdit).toBe(false);
    expect(saved.nextItem.category).toBe('food_ingredients');
    expect(saved.nextItem.quantity).toBe(2);
    expect(saved.nextItem.classification_source).toBe('user');
    expect(saved.nextItem.classification_version).toBe('kept-from-prior-edit');
    expect(categoryEvents).toEqual([prior]);
  });

  it('keeps the current name and does not confirm the category when the name is not an edit field', () => {
    const saved = edit(storedItem());

    expect(saved.categoryChangedThisEdit).toBe(false);
    expect(saved.nextItem.name).toBe('sample spice');
    expect(saved.nextItem.classification_source).toBe('rules');
    expect(fields(saved.nextItem)).not.toContain('item_category');
    expect(fields(saved.nextItem)).not.toContain('item_name');
  });

  it('does not treat a legacy category token as a new correction of its displayed category', () => {
    const stored = storedItem({
      category: 'produce',
      categoryKey: 'produce',
      category_main: 'ingredients',
      category_sub: 'vegetables',
      analysis_tags: [...RICH_PRODUCE_TAGS],
    });
    expect(
      historyItemCategoryChangedThisEdit({
        storedCategory: stored.category,
        itemName: stored.name,
        finalCategory: 'food_ingredients',
      })
    ).toBe(false);

    const saved = edit(stored, { quantity: 2, finalCategory: 'food_ingredients' });

    expect(saved.categoryChangedThisEdit).toBe(false);
    expect(saved.nextItem.classification_source).toBe('rules');
    expect(saved.nextItem.classification_version).toBe('rules-v9');
    expect(saved.nextItem.category_sub).toBe('vegetables');
    expect(saved.nextItem.analysis_tags).toEqual(RICH_PRODUCE_TAGS);
    expect(saved.nextItem.categoryKey).toBe('produce');
    expect(fields(saved.nextItem)).not.toContain('item_category');
    expect(saved.nextItem.quantity).toBe(2);
  });
});
