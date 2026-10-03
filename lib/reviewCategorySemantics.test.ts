import { buildAnalysisTags, mapLegacyCategoryToV1 } from './categoryTaxonomyV1';
import { stampUserClassificationProvenance } from './productTaxonomy';
import {
  historyEditorDisplayedCategory,
  materializeHistoryEditedItemCategorySemantics,
  materializeScanReviewItemCategorySemantics,
} from './reviewCategorySemantics';

const RICH_PRODUCE_TAGS = [
  'ingredient',
  'cooking_related',
  'vegetable_source',
  'bulk_purchase_candidate',
];

function recognitionItem() {
  return {
    name: 'sample spice',
    category: 'ready_to_eat',
    classification_source: 'fallback',
    categoryKey: 'ready_to_eat',
    category_main: 'uncategorized',
    category_sub: 'deli',
    analysis_tags: ['ready_to_eat'],
    classification: { category: 'ready_to_eat', status: 'fallback', confidence: 0.2 },
  };
}

function legacyProduceRow() {
  return {
    name: 'sample spice',
    category: 'produce',
    categoryKey: 'produce',
    category_main: 'ingredients',
    category_sub: 'vegetables',
    analysis_tags: [...RICH_PRODUCE_TAGS],
    classification_source: 'rules',
  };
}

describe('history editor category baseline', () => {
  it('treats legacy produce as the displayed food_ingredients category', () => {
    expect(historyEditorDisplayedCategory('produce', 'sample spice')).toBe(
      'food_ingredients'
    );
  });

  it('keeps richer semantics on a quantity-only edit of normalized legacy produce', () => {
    const stored = legacyProduceRow();
    const displayed = historyEditorDisplayedCategory(stored.category, stored.name);
    const edited = {
      ...stored,
      quantity: 3,
      category: displayed,
      ...stampUserClassificationProvenance(),
    };
    const saved = materializeHistoryEditedItemCategorySemantics(edited, {
      storedCategory: stored.category,
      itemName: stored.name,
      finalCategory: displayed,
    });

    expect(saved).toBe(edited);
    expect(saved.category_main).toBe('ingredients');
    expect(saved.category_sub).toBe('vegetables');
    expect(saved.analysis_tags).toEqual(RICH_PRODUCE_TAGS);
    expect(saved.analysis_tags).toContain('vegetable_source');
    expect(saved.categoryKey).toBe('produce');
  });

  it('rebuilds semantics when the displayed category actually changes to household', () => {
    const stored = legacyProduceRow();
    const edited = {
      ...stored,
      category: 'household',
      ...stampUserClassificationProvenance(),
    };
    const saved = materializeHistoryEditedItemCategorySemantics(edited, {
      storedCategory: stored.category,
      itemName: stored.name,
      finalCategory: 'household',
    });
    const v1 = mapLegacyCategoryToV1('household');

    expect(saved.category).toBe('household');
    expect(saved.classification_source).toBe('user');
    expect(saved.categoryKey).toBe('household');
    expect(saved.category_main).toBe('household');
    expect(saved.category_sub).toBe(v1.sub);
    expect(saved.analysis_tags).toEqual(buildAnalysisTags(v1));
    expect(stored.category_sub).toBe('vegetables');
    expect(stored.analysis_tags).toEqual(RICH_PRODUCE_TAGS);
  });
});

describe('scan review category materialization', () => {
  it('aligns Receipt088 semantics after a real user override and leaves recognition untouched', () => {
    const recognition = recognitionItem();
    const snapshot = { items: [recognition] };
    const reviewed = {
      ...recognition,
      category: 'food_ingredients',
      ...stampUserClassificationProvenance(),
    };
    const saved = materializeScanReviewItemCategorySemantics(reviewed, {
      isUserAdded: false,
      recognitionCategory: recognition.category,
      recognitionItemName: recognition.name,
      finalCategory: 'food_ingredients',
    });
    const v1 = mapLegacyCategoryToV1('food_ingredients');

    expect(saved.category).toBe('food_ingredients');
    expect(saved.classification_source).toBe('user');
    expect(saved.categoryKey).toBe('food_ingredients');
    expect(saved.category_main).toBe('ingredients');
    expect(saved.category_sub).toBe(v1.sub);
    expect(saved.analysis_tags).toEqual(buildAnalysisTags(v1));
    expect(saved.classification).toEqual({
      category: 'food_ingredients',
      status: 'fallback',
      confidence: 0.2,
    });
    expect(snapshot.items[0]).toBe(recognition);
    expect(recognition.category).toBe('ready_to_eat');
    expect(recognition.classification_source).toBe('fallback');
    expect(recognition.categoryKey).toBe('ready_to_eat');
    expect(recognition.category_main).toBe('uncategorized');
  });

  it('preserves fallback provenance and side fields when the category is unchanged', () => {
    const recognition = recognitionItem();
    const saved = materializeScanReviewItemCategorySemantics(recognition, {
      isUserAdded: false,
      recognitionCategory: recognition.category,
      recognitionItemName: recognition.name,
      finalCategory: 'ready_to_eat',
    });
    expect(saved).toBe(recognition);
    expect(saved.classification_source).toBe('fallback');
    expect(saved.categoryKey).toBe('ready_to_eat');
    expect(saved.category_main).toBe('uncategorized');
    expect(saved.category_sub).toBe('deli');
    expect(saved.analysis_tags).toEqual(['ready_to_eat']);
  });

  it('aligns a second user category on the scan review path', () => {
    const recognition = recognitionItem();
    const reviewed = {
      ...recognition,
      category: 'household',
      ...stampUserClassificationProvenance(),
    };
    const saved = materializeScanReviewItemCategorySemantics(reviewed, {
      isUserAdded: false,
      recognitionCategory: recognition.category,
      recognitionItemName: recognition.name,
      finalCategory: 'household',
    });
    expect(saved.category).toBe('household');
    expect(saved.classification_source).toBe('user');
    expect(saved.categoryKey).toBe('household');
    expect(saved.category_main).toBe('household');
    expect(saved.category_sub).toBe('cleaning');
  });
});

describe('sparse and unknown category fields', () => {
  it('updates categoryKey without creating category_main', () => {
    const saved = materializeScanReviewItemCategorySemantics(
      {
        name: 'sample spice',
        category: 'food_ingredients',
        categoryKey: 'ready_to_eat',
        ...stampUserClassificationProvenance(),
      },
      {
        isUserAdded: false,
        recognitionCategory: 'ready_to_eat',
        recognitionItemName: 'sample spice',
        finalCategory: 'food_ingredients',
      }
    );
    expect(saved.categoryKey).toBe('food_ingredients');
    expect(Object.prototype.hasOwnProperty.call(saved, 'category_main')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(saved, 'category_sub')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(saved, 'analysis_tags')).toBe(false);
  });

  it('updates category_main without creating categoryKey', () => {
    const saved = materializeHistoryEditedItemCategorySemantics(
      {
        name: 'sample spice',
        category: 'household',
        category_main: 'prepared_food',
        ...stampUserClassificationProvenance(),
      },
      {
        storedCategory: 'ready_to_eat',
        itemName: 'sample spice',
        finalCategory: 'household',
      }
    );
    expect(saved.category_main).toBe('household');
    expect(Object.prototype.hasOwnProperty.call(saved, 'categoryKey')).toBe(false);
  });

  it('preserves sub and tags when an unknown legacy category still displays as uncategorized', () => {
    const stored = {
      name: 'sample spice',
      category: 'zz_legacy_token',
      category_main: 'ingredients',
      category_sub: 'vegetables',
      analysis_tags: [...RICH_PRODUCE_TAGS],
    };
    expect(historyEditorDisplayedCategory(stored.category, stored.name)).toBe(
      'uncategorized'
    );
    const edited = { ...stored, category: 'uncategorized', quantity: 2 };
    const saved = materializeHistoryEditedItemCategorySemantics(edited, {
      storedCategory: stored.category,
      itemName: stored.name,
      finalCategory: 'uncategorized',
    });
    expect(saved).toBe(edited);
    expect(saved.category_sub).toBe('vegetables');
    expect(saved.analysis_tags).toEqual(RICH_PRODUCE_TAGS);
  });

  it('rebuilds a real change away from uncategorized with the existing mapping', () => {
    const saved = materializeHistoryEditedItemCategorySemantics(
      {
        name: 'sample spice',
        category: 'food_ingredients',
        category_main: 'uncategorized',
        category_sub: 'deli',
        analysis_tags: ['ready_to_eat'],
        ...stampUserClassificationProvenance(),
      },
      {
        storedCategory: 'uncategorized',
        itemName: 'sample spice',
        finalCategory: 'food_ingredients',
      }
    );
    const v1 = mapLegacyCategoryToV1('food_ingredients');
    expect(saved.category).toBe('food_ingredients');
    expect(saved.category_main).toBe(v1.main);
    expect(saved.category_sub).toBe(v1.sub);
    expect(saved.analysis_tags).toEqual(buildAnalysisTags(v1));
    expect(v1.main).toBe('ingredients');
  });

  it('maps an explicit change to uncategorized through the existing helper', () => {
    const saved = materializeScanReviewItemCategorySemantics(
      {
        name: 'sample spice',
        category: 'uncategorized',
        categoryKey: 'ready_to_eat',
        category_main: 'prepared_food',
        category_sub: 'deli',
        analysis_tags: ['ready_to_eat'],
        ...stampUserClassificationProvenance(),
      },
      {
        isUserAdded: false,
        recognitionCategory: 'ready_to_eat',
        recognitionItemName: 'sample spice',
        finalCategory: 'uncategorized',
      }
    );
    const v1 = mapLegacyCategoryToV1('uncategorized');
    expect(saved.category).toBe('uncategorized');
    expect(saved.categoryKey).toBe('uncategorized');
    expect(saved.category_main).toBe(v1.main);
    expect(saved.category_sub).toBe(v1.sub);
    expect(saved.analysis_tags).toEqual(buildAnalysisTags(v1));
    expect(v1).toEqual({ main: 'uncategorized', sub: null });
  });
});
