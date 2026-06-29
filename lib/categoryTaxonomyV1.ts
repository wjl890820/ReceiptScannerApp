// lib/categoryTaxonomyV1.ts
// V1 main/sub taxonomy for grocery & convenience store items.

export type MainCategory =
  | 'ingredients'
  | 'prepared_food'
  | 'snacks'
  | 'beverages'
  | 'alcohol'
  | 'household'
  | 'health'
  | 'other'
  | 'uncategorized';

export type SubCategory =
  // ingredients
  | 'vegetables'
  | 'fruits'
  | 'meat'
  | 'seafood'
  | 'dairy'
  | 'eggs'
  | 'soy_products'
  | 'staples'
  | 'seasonings'
  | 'dried_goods'
  | 'frozen_ingredients'
  // prepared_food
  | 'bento'
  | 'rice_balls'
  | 'sandwiches'
  | 'deli'
  | 'instant_food'
  | 'frozen_food'
  | 'canned_food'
  | 'salads'
  // snacks
  | 'chips'
  | 'chocolate'
  | 'biscuits'
  | 'cakes'
  | 'desserts'
  | 'ice_cream'
  | 'candy'
  // beverages
  | 'water'
  | 'tea'
  | 'coffee'
  | 'carbonated_drinks'
  | 'juice'
  | 'energy_drinks'
  // alcohol
  | 'beer'
  | 'sake'
  | 'shochu'
  | 'wine'
  | 'whisky'
  // household
  | 'cleaning'
  | 'laundry'
  | 'kitchen'
  | 'tissue_paper'
  | 'bath_body'
  | 'oral_care'
  | 'batteries'
  | 'trash_bags'
  | 'wraps_storage'
  | 'disposable_goods'
  // health
  | 'supplements'
  | 'vitamins'
  | 'protein'
  | 'energy_nutrition';

export type AnalysisTag =
  | 'ingredient'
  | 'ready_to_eat'
  | 'snack'
  | 'sweet'
  | 'sugary_drink'
  | 'alcoholic'
  | 'household_essential'
  | 'restock_candidate'
  | 'cooking_related'
  | 'non_essential_spend'
  | 'protein_source'
  | 'vegetable_source'
  | 'frozen_item'
  | 'bulk_purchase_candidate';

export type MainSub = {
  main: MainCategory;
  sub: SubCategory | null;
};

/**
 * Map V1 main/sub to legacy single-level category key (for current UI/analytics and learned mapping storage).
 * This is a compatibility bridge and can be removed after UI migrates to main/sub.
 */
export function mapV1ToLegacyCategory(v1: MainSub): string {
  if (v1.main === 'ingredients') {
    if (v1.sub === 'dairy') return 'dairy_eggs';
    if (v1.sub === 'eggs') return 'dairy_eggs';
    if (v1.sub === 'meat' || v1.sub === 'seafood') return 'meat_seafood';
    if (v1.sub === 'seasonings') return 'condiments';
    if (v1.sub === 'staples') return 'staples';
    return 'produce';
  }
  if (v1.main === 'prepared_food') {
    if (v1.sub === 'frozen_food') return 'frozen_foods';
    if (v1.sub === 'canned_food') return 'canned_preserved';
    return 'quick_meals';
  }
  if (v1.main === 'snacks') return 'snacks_sweets';
  if (v1.main === 'beverages') return 'non_alcoholic_drinks';
  if (v1.main === 'alcohol') return 'alcohol';
  if (v1.main === 'household') return 'household';
  if (v1.main === 'health') return 'health_supplements';
  if (v1.main === 'uncategorized') return 'uncategorized';
  return 'other_grocery';
}

/**
 * Map legacy single-level category (stored in item.category) to V1 main/sub.
 * This is a compatibility bridge; rules can later output main/sub directly.
 */
export function mapLegacyCategoryToV1(category: string | null | undefined): MainSub {
  const c = (category || '').trim();
  if (!c) return { main: 'uncategorized', sub: null };

  switch (c) {
    // ---- 新一级分类（ProductCategory）→ V1 ----
    case 'food_ingredients':
      return { main: 'ingredients', sub: null };
    case 'ready_to_eat':
      return { main: 'prepared_food', sub: null };
    case 'snacks_drinks':
      return { main: 'snacks', sub: null };
    case 'personal_care':
      return { main: 'health', sub: null };
    case 'pet_care':
      return { main: 'other', sub: null };
    // ---- 旧 16 类 → V1 ----
    case 'produce':
      return { main: 'ingredients', sub: 'vegetables' };
    case 'meat_seafood':
      return { main: 'ingredients', sub: 'meat' };
    case 'dairy_eggs':
      return { main: 'ingredients', sub: 'dairy' };
    case 'bakery':
      return { main: 'prepared_food', sub: 'sandwiches' };
    case 'staples':
      return { main: 'ingredients', sub: 'staples' };
    case 'condiments':
      return { main: 'ingredients', sub: 'seasonings' };
    case 'quick_meals':
      return { main: 'prepared_food', sub: 'bento' };
    case 'frozen_foods':
      return { main: 'prepared_food', sub: 'frozen_food' };
    case 'canned_preserved':
      return { main: 'prepared_food', sub: 'canned_food' };
    case 'snacks_sweets':
      return { main: 'snacks', sub: 'chips' };
    case 'non_alcoholic_drinks':
      return { main: 'beverages', sub: 'tea' };
    case 'beverages_other':
      return { main: 'beverages', sub: 'energy_drinks' };
    case 'alcohol':
      return { main: 'alcohol', sub: 'beer' };
    case 'household':
      return { main: 'household', sub: 'cleaning' };
    case 'health_supplements':
      return { main: 'health', sub: 'supplements' };
    case 'other_grocery':
      return { main: 'other', sub: null };
    case 'uncategorized':
      return { main: 'uncategorized', sub: null };
    case 'non_grocery':
      return { main: 'other', sub: null };
    default:
      return { main: 'other', sub: null };
  }
}

export function buildAnalysisTags(v1: MainSub): AnalysisTag[] {
  const tags: AnalysisTag[] = [];

  if (v1.main === 'ingredients') {
    tags.push('ingredient', 'cooking_related');
    if (v1.sub === 'vegetables') tags.push('vegetable_source');
    if (v1.sub === 'meat' || v1.sub === 'seafood' || v1.sub === 'eggs' || v1.sub === 'dairy') {
      tags.push('protein_source');
    }
    if (v1.sub === 'frozen_ingredients') tags.push('frozen_item');
  }

  if (v1.main === 'prepared_food') {
    tags.push('ready_to_eat');
    tags.push('non_essential_spend');
    if (v1.sub === 'frozen_food') tags.push('frozen_item');
  }

  if (v1.main === 'snacks') {
    tags.push('snack', 'non_essential_spend');
    if (v1.sub === 'chocolate' || v1.sub === 'cakes' || v1.sub === 'desserts' || v1.sub === 'ice_cream' || v1.sub === 'candy') {
      tags.push('sweet');
    }
  }

  if (v1.main === 'beverages') {
    if (v1.sub === 'carbonated_drinks' || v1.sub === 'juice' || v1.sub === 'energy_drinks') tags.push('sugary_drink');
    tags.push('non_essential_spend');
  }

  if (v1.main === 'alcohol') tags.push('alcoholic', 'non_essential_spend');
  if (v1.main === 'household') tags.push('household_essential');

  // de-dupe
  return Array.from(new Set(tags));
}

