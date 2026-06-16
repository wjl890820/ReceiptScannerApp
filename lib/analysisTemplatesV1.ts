// lib/analysisTemplatesV1.ts
// Fixed templates (keys only) for product design & later AI copy layer.

import type {
  AggregateAnalysisOutputV1,
  ReceiptAnalysisOutputV1,
  WeeklyReportV1,
  MonthlyReportV1,
} from './growthAnalysisEngineV1';

export type TemplateV1 = {
  level: 'L1' | 'L2' | 'L3';
  title_key: string;
  summary_key: string;
  bullet_keys: string[];
  suggestion_keys: string[];
};

export type TemplatesBundleV1 = {
  receipt_template: TemplateV1;
  growth_template?: TemplateV1;
};

function shoppingTypeKey(type: ReceiptAnalysisOutputV1['shopping_type']): string {
  switch (type) {
    case 'cook_stockup':
      return 'analysis.templates.shoppingType.cookStockup';
    case 'ready_to_eat':
      return 'analysis.templates.shoppingType.readyToEat';
    case 'snacks_beverages':
      return 'analysis.templates.shoppingType.snacksBeverages';
    case 'household_restock':
      return 'analysis.templates.shoppingType.householdRestock';
    case 'bulk_stockup':
      return 'analysis.templates.shoppingType.bulkStockup';
    case 'mixed':
      return 'analysis.templates.shoppingType.mixed';
    default:
      return 'analysis.templates.shoppingType.unknown';
  }
}

export function buildReceiptTemplateL1(receipt: ReceiptAnalysisOutputV1): TemplateV1 {
  const typeKey = shoppingTypeKey(receipt.shopping_type);
  const suggestions = (receipt.suggestions_seed || []).slice(0, 2).map((s) => `analysis.templates.suggestion.${s}`);
  return {
    level: 'L1',
    title_key: 'analysis.templates.l1.title',
    summary_key: typeKey,
    bullet_keys: [
      'analysis.templates.l1.bullet.shoppingType',
      'analysis.templates.l1.bullet.structure',
    ],
    suggestion_keys: suggestions.length ? suggestions : ['analysis.templates.suggestion.none'],
  };
}

export function buildGrowthTemplateL2(params: {
  aggregate: AggregateAnalysisOutputV1;
  weekly?: WeeklyReportV1;
}): TemplateV1 {
  return {
    level: 'L2',
    title_key: 'analysis.templates.l2.title',
    summary_key: 'analysis.templates.l2.summary',
    bullet_keys: [
      'analysis.templates.l2.bullet.breakdown',
      'analysis.templates.l2.bullet.tendency',
      'analysis.templates.l2.bullet.repeatedCategories',
      ...(params.weekly ? ['analysis.templates.l2.bullet.weeklySnapshot'] : []),
    ],
    suggestion_keys: [
      'analysis.templates.l2.suggestion.trackPatterns',
      'analysis.templates.l2.suggestion.improveCoverage',
    ],
  };
}

export function buildGrowthTemplateL3(params: {
  aggregate: AggregateAnalysisOutputV1;
  weekly?: WeeklyReportV1;
  monthly?: MonthlyReportV1;
}): TemplateV1 {
  return {
    level: 'L3',
    title_key: 'analysis.templates.l3.title',
    summary_key: 'analysis.templates.l3.summary',
    bullet_keys: [
      'analysis.templates.l3.bullet.habits',
      'analysis.templates.l3.bullet.dominantPattern',
      'analysis.templates.l3.bullet.repeatedItems',
      ...(params.weekly ? ['analysis.templates.l3.bullet.weeklySignals'] : []),
      ...(params.monthly ? ['analysis.templates.l3.bullet.monthlySignals'] : []),
    ],
    suggestion_keys: [
      'analysis.templates.l3.suggestion.balanceStructure',
      'analysis.templates.l3.suggestion.reduceNonEssential',
    ],
  };
}

