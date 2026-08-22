/**
 * M1-A: taxonomy + classification provenance contract tests.
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({}));
jest.mock('./db', () => ({ initIfNeeded: jest.fn() }));

import {
  TAXONOMY_VERSION,
  CLASSIFICATION_VERSION,
  LEGACY_CLASSIFICATION_VERSION,
  V1_SPENDING_CATEGORIES,
  SYSTEM_CATEGORY_STATES,
  V1_WRITABLE_CATEGORIES,
  isV1SpendingCategory,
  isSystemCategoryState,
  isV1WritableCategory,
  isExplicitUserCategoryOverride,
  stampMachineClassificationProvenance,
  stampUserClassificationProvenance,
  resolveClassificationProvenance,
} from './productTaxonomy';
import {
  V1_ACTIVE_PRODUCT_CATEGORIES,
  V1_SPENDING_PRODUCT_CATEGORIES,
  sanitizeV1ActiveCategoryWrite,
  normalizePersistedProductCategory,
} from './productCategory';
import { fixJsonItems } from './categoryBackfill';
import { isGroceryCategory, isExcludedFromAnalytics } from './categories';
import { buildAnalysisCategoryShares } from './analysisPresentation';
import type { WeeklyMonthlyStats } from './statsCalculator';

describe('M1-A taxonomy contract', () => {
  it('A — personal_care is a valid active V1 spending category', () => {
    expect(isV1SpendingCategory('personal_care')).toBe(true);
    expect(sanitizeV1ActiveCategoryWrite('personal_care')).toBe('personal_care');
    expect(V1_SPENDING_CATEGORIES).toContain('personal_care');
  });

  it('B — pet_care is a valid active V1 spending category', () => {
    expect(isV1SpendingCategory('pet_care')).toBe(true);
    expect(sanitizeV1ActiveCategoryWrite('pet_care')).toBe('pet_care');
    expect(V1_SPENDING_CATEGORIES).toContain('pet_care');
  });

  it('C — uncategorized is system/review state, not a spending category', () => {
    expect(isSystemCategoryState('uncategorized')).toBe(true);
    expect(isV1SpendingCategory('uncategorized')).toBe(false);
    expect([...SYSTEM_CATEGORY_STATES]).toEqual(['uncategorized']);
    expect(isExcludedFromAnalytics('uncategorized')).toBe(true);
    expect(isGroceryCategory('uncategorized')).toBe(false);
  });

  it('D — active category consumers share centralized taxonomy contract', () => {
    expect([...V1_SPENDING_PRODUCT_CATEGORIES]).toEqual([...V1_SPENDING_CATEGORIES]);
    expect([...V1_ACTIVE_PRODUCT_CATEGORIES]).toEqual([...V1_WRITABLE_CATEGORIES]);
    expect([...V1_WRITABLE_CATEGORIES]).toEqual([
      'food_ingredients',
      'ready_to_eat',
      'snacks_drinks',
      'household',
      'personal_care',
      'pet_care',
      'other',
      'uncategorized',
    ]);
  });

  it('E — classification result stamp contains source + versions', () => {
    const stamped = stampMachineClassificationProvenance('name_rule');
    expect(stamped).toEqual({
      classification_source: 'name_rule',
      classification_version: CLASSIFICATION_VERSION,
      taxonomy_version: TAXONOMY_VERSION,
    });
    expect(TAXONOMY_VERSION).toBe('meruno-taxonomy-v1');
    expect(CLASSIFICATION_VERSION).toBe('meruno-classify-rules-v1');
  });

  it('F — legacy classification without exact provenance degrades safely', () => {
    const resolved = resolveClassificationProvenance({
      category: 'household',
      classification_source: 'rules',
    });
    expect(resolved.classification_source).toBe('rules');
    expect(resolved.taxonomy_version).toBe(TAXONOMY_VERSION);
    expect(resolved.classification_version).toBe(LEGACY_CLASSIFICATION_VERSION);
    expect(LEGACY_CLASSIFICATION_VERSION).toBe('legacy_unknown');
  });

  it('G — user category override survives backfill on user layer', () => {
    const json = JSON.stringify({
      items: [
        {
          name: '豆腐',
          category: 'other',
          classification_source: 'user',
          lineTotal: 100,
        },
      ],
    });
    expect(fixJsonItems(json, { layer: 'user' })).toBeNull();
  });

  it('H — machine backfill does not overwrite explicit user override on analysis layer', () => {
    const json = JSON.stringify({
      items: [
        {
          name: '豆腐',
          category: 'other',
          classification_source: 'user',
          lineTotal: 100,
        },
      ],
    });
    expect(fixJsonItems(json, { layer: 'analysis' })).toBeNull();
  });

  it('I — existing personal_care/pet_care data remains readable', () => {
    expect(normalizePersistedProductCategory('personal_care')).toBe('personal_care');
    expect(normalizePersistedProductCategory('pet_care')).toBe('pet_care');
    expect(isV1WritableCategory('personal_care')).toBe(true);
    expect(isGroceryCategory('personal_care')).toBe(true);
    expect(isGroceryCategory('pet_care')).toBe(true);
  });

  it('J — Analysis category denominator uses spending categories (Phase B semantics)', () => {
    const stats: WeeklyMonthlyStats = {
      totalSpend: 1000,
      grocerySpend: 1000,
      supportedSpend: 1000,
      supportedReceiptCount: 3,
      categoryBreakdown: [
        { category: 'food_ingredients', amount: 400 },
        { category: 'personal_care', amount: 300 },
        { category: 'pet_care', amount: 200 },
      ],
      topCategories: [
        { category: 'food_ingredients', amount: 400 },
        { category: 'personal_care', amount: 300 },
        { category: 'pet_care', amount: 200 },
      ],
      categoryCompositionTotal: 900,
      topMerchants: [],
      highestSingleReceipt: null,
      mostFrequentMerchant: null,
      uncategorizedCount: 1,
      uncategorizedTotal: 100,
    };

    const shares = buildAnalysisCategoryShares(stats);
    expect(shares.map((s) => s.category)).toEqual([
      'food_ingredients',
      'personal_care',
      'pet_care',
    ]);
    expect(shares.find((s) => s.category === 'uncategorized')).toBeUndefined();
    expect(shares.find((s) => s.category === 'personal_care')?.share).toBeCloseTo(300 / 900);
  });

  it('user stamp uses source=user and null classification_version', () => {
    expect(stampUserClassificationProvenance()).toEqual({
      classification_source: 'user',
      classification_version: null,
      taxonomy_version: TAXONOMY_VERSION,
    });
    expect(isExplicitUserCategoryOverride({ classification_source: 'user' })).toBe(true);
  });
});
