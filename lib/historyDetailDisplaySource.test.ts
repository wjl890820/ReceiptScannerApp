import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  categoryDisplayPercent,
  sumCategoryDisplayAmounts,
} from './historyDetailCategoryShare';
import {
  buildHistoryDetailCategorySummary,
  selectHistoryDetailDisplayItems,
} from './historyDetailDisplaySource';

const ANALYSIS_ITEMS = [
  { name: 'analysis flour', category: 'food_ingredients', lineTotal: 100 },
  { name: 'analysis bento', category: 'ready_to_eat', lineTotal: 100 },
];

const USER_ITEMS = [
  { name: 'user cola', category: 'snacks_drinks', lineTotal: 300 },
  { name: 'user soap', category: 'household', lineTotal: 100 },
];

const EXTERNAL_TAX_USER_ITEMS = [
  { name: 'user snacks', category: 'snacks_drinks', lineTotal: 1418 },
  { name: 'user ready', category: 'ready_to_eat', lineTotal: 350 },
  { name: 'user ingredients', category: 'food_ingredients', lineTotal: 208 },
];

function rowsFrom(input: {
  userItemsJson: string | null | undefined;
  analysisItems?: readonly unknown[] | null;
}) {
  return buildHistoryDetailCategorySummary(
    selectHistoryDetailDisplayItems(input)
  );
}

describe('history detail display source', () => {
  it('uses disagreeing user_items_json and ignores analysis items', () => {
    const selected = selectHistoryDetailDisplayItems({
      userItemsJson: JSON.stringify(USER_ITEMS),
      analysisItems: ANALYSIS_ITEMS,
    });
    expect(selected).toEqual(USER_ITEMS);
    expect(selected).not.toEqual(ANALYSIS_ITEMS);

    const rows = buildHistoryDetailCategorySummary(selected);
    expect(rows).toEqual([
      { category: 'snacks_drinks', amount: 300 },
      { category: 'household', amount: 100 },
    ]);
    const categoryDisplayTotal = sumCategoryDisplayAmounts(rows);
    expect(categoryDisplayTotal).toBe(400);
    expect(categoryDisplayPercent(300, categoryDisplayTotal)).toBe(75);
    expect(categoryDisplayPercent(100, categoryDisplayTotal)).toBe(25);
  });

  it('falls back to analysis_json.items when user_items_json is absent', () => {
    const rows = rowsFrom({
      userItemsJson: null,
      analysisItems: ANALYSIS_ITEMS,
    });
    expect(rows).toEqual([
      { category: 'food_ingredients', amount: 100 },
      { category: 'ready_to_eat', amount: 100 },
    ]);
    expect(sumCategoryDisplayAmounts(rows)).toBe(200);
    expect(categoryDisplayPercent(100, sumCategoryDisplayAmounts(rows))).toBe(50);
  });

  it('falls back for empty, malformed, and non-array user_items_json', () => {
    for (const userItemsJson of ['[]', '{', '{"not":"items"}', 'null', '']) {
      const selected = selectHistoryDetailDisplayItems({
        userItemsJson,
        analysisItems: ANALYSIS_ITEMS,
      });
      expect(selected).toBe(ANALYSIS_ITEMS);
      expect(buildHistoryDetailCategorySummary(selected)).toEqual([
        { category: 'food_ingredients', amount: 100 },
        { category: 'ready_to_eat', amount: 100 },
      ]);
    }
  });

  it('changes category rows when the same analysis shell gains user items', () => {
    const fromAnalysis = rowsFrom({
      userItemsJson: undefined,
      analysisItems: ANALYSIS_ITEMS,
    });
    const fromUser = rowsFrom({
      userItemsJson: JSON.stringify(USER_ITEMS),
      analysisItems: ANALYSIS_ITEMS,
    });
    expect(fromUser).not.toEqual(fromAnalysis);
    expect(fromUser.map((row) => row.category)).toEqual([
      'snacks_drinks',
      'household',
    ]);
    expect(fromAnalysis.map((row) => row.category)).toEqual([
      'food_ingredients',
      'ready_to_eat',
    ]);
  });

  it('uses the selected category sum, not a mismatched receipt total', () => {
    const receiptTotal = 2134;
    const rows = rowsFrom({
      userItemsJson: JSON.stringify(EXTERNAL_TAX_USER_ITEMS),
      analysisItems: ANALYSIS_ITEMS,
    });
    const categoryDisplayTotal = sumCategoryDisplayAmounts(rows);
    expect(rows.map((row) => row.category)).toEqual([
      'snacks_drinks',
      'ready_to_eat',
      'food_ingredients',
    ]);
    expect(categoryDisplayTotal).toBe(1976);
    expect(categoryDisplayTotal).not.toBe(receiptTotal);
    expect(categoryDisplayPercent(1418, categoryDisplayTotal)).toBeCloseTo(
      (1418 / 1976) * 100,
      5
    );
    expect(categoryDisplayPercent(1418, receiptTotal)).not.toBeCloseTo(
      categoryDisplayPercent(1418, categoryDisplayTotal),
      1
    );
  });
});

function stripComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i);
      i = newline < 0 ? source.length : newline;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    out += source[i];
  }
  return out;
}

function sourceRegion(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`missing source region ${startMarker} .. ${endMarker}`);
  }
  return source.slice(start, end);
}

function compactSource(source: string): string {
  return source.replace(/\s+/g, '').replace(/,([}\]])/g, '$1').replace(/,$/g, '');
}

/** Argument text of the first real `name(` call. Comments are already removed by the caller. */
function callArguments(region: string, helperName: string): string | null {
  const match = new RegExp(`\\b${helperName}\\s*\\(`).exec(region);
  if (!match) return null;
  let depth = 1;
  let args = '';
  for (let i = match.index + match[0].length; i < region.length; i += 1) {
    const ch = region[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return args;
    }
    args += ch;
  }
  return null;
}

function acceptsDisplayItemSelection(args: string | null): boolean {
  const compact = compactSource(args ?? '');
  const objectForms = new Set([
    '{userItemsJson:receipt.user_items_json,analysisItems:analysis?.items}',
    '{analysisItems:analysis?.items,userItemsJson:receipt.user_items_json}',
  ]);
  return (
    objectForms.has(compact) || compact === 'receipt.user_items_json,analysis?.items'
  );
}

function acceptsCategorySummaryInput(args: string | null): boolean {
  return compactSource(args ?? '') === 'displayAnalysis.items';
}

function categoryRatioRowElement(region: string): string | null {
  const start = region.indexOf('<CategoryRatioRow');
  if (start < 0) return null;
  const end = region.indexOf('/>', start);
  if (end < 0) return null;
  return region.slice(start, end + 2);
}

function acceptsRenderedCategoryPercent(row: string | null): boolean {
  const compact = compactSource(row ?? '');
  const accepted =
    compact.includes('percent={categoryDisplayPercent(x.amount,categoryDisplayTotal)}') ||
    compact.includes('percent={x.amount/categoryDisplayTotal}');
  const rejectedDenominator =
    /(?:receipt\.total|displayTotal|supportedSpend)/.test(compact);
  return accepted && !rejectedDenominator;
}

describe('history detail display source page wiring', () => {
  const page = readFileSync(
    join(__dirname, '../app/(tabs)/history/[id].tsx'),
    'utf8'
  );

  it('displayItems selection passes user_items_json and analysis items', () => {
    const region = stripComments(
      sourceRegion(
        page,
        'const displayItems = useMemo(() => {',
        'const displayAnalysis = useMemo(() => {'
      )
    );
    expect(region).not.toMatch(/^\s*import\s/m);
    expect(
      acceptsDisplayItemSelection(
        callArguments(region, 'selectHistoryDetailDisplayItems')
      )
    ).toBe(true);
  });

  it('category summary is built from displayAnalysis.items', () => {
    const region = stripComments(
      sourceRegion(
        page,
        'const categorySummary = useMemo(() => {',
        'const categoryDisplayTotal = useMemo('
      )
    );
    expect(region).not.toMatch(/^\s*import\s/m);
    expect(
      acceptsCategorySummaryInput(
        callArguments(region, 'buildHistoryDetailCategorySummary')
      )
    ).toBe(true);
  });

  it('rendered category percent divides by categoryDisplayTotal', () => {
    const region = stripComments(
      sourceRegion(page, '{/* 分类汇总 */}', '{/* 商品明细 */}')
    );
    const row = categoryRatioRowElement(region);
    expect(row).toContain('CategoryRatioRow');
    expect(acceptsRenderedCategoryPercent(row)).toBe(true);
  });

  it('rejects swapped inputs, analysis-only summary, and receipt-total percents', () => {
    expect(
      acceptsDisplayItemSelection('analysis?.items, analysis?.items')
    ).toBe(false);
    expect(
      acceptsDisplayItemSelection(
        '{ userItemsJson: analysis?.items, analysisItems: analysis?.items }'
      )
    ).toBe(false);
    expect(
      acceptsDisplayItemSelection(
        '{ analysisItems: receipt.user_items_json, userItemsJson: analysis?.items }'
      )
    ).toBe(false);
    expect(
      acceptsDisplayItemSelection('{ analysisItems: analysis?.items }')
    ).toBe(false);
    expect(acceptsDisplayItemSelection('receipt.user_items_json, other')).toBe(
      false
    );
    expect(
      acceptsDisplayItemSelection(
        '{ userItemsJson: receipt.user_items_json, analysisItems: analysis?.items }'
      )
    ).toBe(true);
    expect(
      acceptsDisplayItemSelection('receipt.user_items_json, analysis?.items')
    ).toBe(true);

    expect(acceptsCategorySummaryInput('analysis?.items')).toBe(false);
    expect(acceptsCategorySummaryInput('displayAnalysis.items')).toBe(true);
    expect(
      callArguments(
        stripComments(
          '// buildHistoryDetailCategorySummary(displayAnalysis.items)\n/* buildHistoryDetailCategorySummary(analysis?.items) */'
        ),
        'buildHistoryDetailCategorySummary'
      )
    ).toBeNull();

    expect(
      acceptsRenderedCategoryPercent(
        '<CategoryRatioRow percent={x.amount / displayTotal} />'
      )
    ).toBe(false);
    expect(
      acceptsRenderedCategoryPercent(
        '<CategoryRatioRow percent={categoryDisplayPercent(x.amount, receipt.total)} />'
      )
    ).toBe(false);
    expect(
      acceptsRenderedCategoryPercent(
        '<CategoryRatioRow percent={x.amount / supportedSpend} />'
      )
    ).toBe(false);
    expect(
      acceptsRenderedCategoryPercent(
        '<CategoryRatioRow percent={categoryDisplayPercent(x.amount, categoryDisplayTotal)} />'
      )
    ).toBe(true);
    expect(
      acceptsRenderedCategoryPercent(
        '<CategoryRatioRow percent={x.amount / categoryDisplayTotal} />'
      )
    ).toBe(true);
  });
});
