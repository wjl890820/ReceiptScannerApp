import * as fs from 'fs';
import * as path from 'path';

import { getEngagementMilestoneStatus } from './engagementMilestones';
import {
  buildPostSaveMilestoneViewModel,
  formatMilestoneRecentChange,
  formatMilestoneSummary,
} from './milestonePresentation';
import {
  buildPostSaveSummaryHref,
  getPostSavePrimaryDestination,
  parsePostSaveSummaryRouteContext,
} from './postSaveSummaryNavigation';

describe('post-save navigation decisions', () => {
  it('always navigates a successful single save to Summary, then Home', () => {
    expect(buildPostSaveSummaryHref('receipt-1', null)).toBe(
      '/post-save-summary/receipt-1'
    );
    expect(getPostSavePrimaryDestination(null)).toBe('/');
  });

  it('carries only encoded receipt and next-draft context for multi-image review', () => {
    const href = buildPostSaveSummaryHref(
      'receipt / 日本',
      'draft / 次'
    );
    const url = new URL(href, 'https://receipt.local');

    expect(url.pathname).toBe(
      '/post-save-summary/receipt%20%2F%20%E6%97%A5%E6%9C%AC'
    );
    expect(url.searchParams.get('nextDraftId')).toBe('draft / 次');
    expect(href).not.toContain('{');
    expect(getPostSavePrimaryDestination('draft / 次')).toBe(
      '/scan-review/draft%20%2F%20%E6%AC%A1'
    );
  });

  it('preserves A → Summary A → B → Summary B → C → Summary C → Home', () => {
    const sequence = [
      buildPostSaveSummaryHref('receipt-a', 'draft-b'),
      getPostSavePrimaryDestination('draft-b'),
      buildPostSaveSummaryHref('receipt-b', 'draft-c'),
      getPostSavePrimaryDestination('draft-c'),
      buildPostSaveSummaryHref('receipt-c', null),
      getPostSavePrimaryDestination(null),
    ];
    expect(sequence).toEqual([
      '/post-save-summary/receipt-a?nextDraftId=draft-b',
      '/scan-review/draft-b',
      '/post-save-summary/receipt-b?nextDraftId=draft-c',
      '/scan-review/draft-c',
      '/post-save-summary/receipt-c',
      '/',
    ]);
  });

  it('parses only minimal route context and rejects missing receipt id', () => {
    expect(
      parsePostSaveSummaryRouteContext(['receipt-1'], ['draft-2'])
    ).toEqual({ receiptId: 'receipt-1', nextDraftId: 'draft-2' });
    expect(parsePostSaveSummaryRouteContext('', null)).toBeNull();
  });
});

describe('post-save milestone presentation state', () => {
  it.each([
    [0, 1, 1, 3, 2],
    [2, 3, 3, 5, 2],
    [3, 4, null, 5, 1],
    [4, 5, 5, 10, 5],
    [9, 10, 10, null, null],
  ] as const)(
    'before %s after %s resolves unlock %s, next %s, remaining %s',
    (before, after, unlock, next, remaining) => {
      const viewModel = buildPostSaveMilestoneViewModel(
        true,
        getEngagementMilestoneStatus(after, before)
      );
      expect(viewModel).toMatchObject({
        showProgress: true,
        unlockedMilestone: unlock,
        nextMilestone: next,
        receiptsUntilNext: remaining,
      });
    }
  );

  it('shows no milestone progress for unsupported receipts', () => {
    const viewModel = buildPostSaveMilestoneViewModel(
      false,
      getEngagementMilestoneStatus(2, 2)
    );
    expect(viewModel).toMatchObject({
      showProgress: false,
      unlockedMilestone: null,
      supportedReceiptCount: null,
    });
  });

  it('stops at the established profile and never invents milestone 20', () => {
    const viewModel = buildPostSaveMilestoneViewModel(
      true,
      getEngagementMilestoneStatus(11, 10)
    );
    expect(viewModel).toMatchObject({
      profileEstablished: true,
      nextMilestone: null,
      receiptsUntilNext: null,
    });
  });

  it('degrades to saved-only state without blocking navigation', () => {
    expect(buildPostSaveMilestoneViewModel(true, null).showProgress).toBe(
      false
    );
    expect(getPostSavePrimaryDestination('next-draft')).toBe(
      '/scan-review/next-draft'
    );
  });
});

describe('deterministic summary formatting', () => {
  const translate = (
    key: string,
    params?: Record<string, string | number>
  ) => `${key}:${JSON.stringify(params ?? {})}`;
  const categoryLabel = (category: string) => `label(${category})`;

  it('formats engine summary keys without making new statistical decisions', () => {
    const formatted = formatMilestoneSummary(
      {
        summaryType: 'dominant_category',
        summaryKey:
          'engagementMilestone.summary.dominant.food_ingredients',
        data: {
          category: 'food_ingredients',
          share: 0.62,
          metric: 'spend',
        },
      },
      translate,
      categoryLabel
    );
    expect(formatted).toContain(
      'engagementMilestone.summary.dominant.food_ingredients'
    );
    expect(formatted).toContain('"percentage":62');
    expect(formatted).toContain('"category":"label(food_ingredients)"');
  });

  it('formats only the engine-decided category change direction and magnitude', () => {
    const formatted = formatMilestoneRecentChange(
      {
        changeType: 'category_share_increase',
        summaryKey: 'engagementMilestone.change.categoryIncrease',
        category: 'food_ingredients',
        firstShare: 0.2,
        latestShare: 0.4,
        differencePercentagePoints: 20,
      },
      translate,
      categoryLabel
    );
    expect(formatted).toContain(
      'engagementMilestone.change.categoryIncrease'
    );
    expect(formatted).toContain('"difference":20');
  });
});

describe('Post-Save Summary dependency boundary', () => {
  it('keeps persistence, draft cleanup, learning, and post-save work before navigation', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/scan-review/[draftId].tsx'),
      'utf8'
    );
    const saveIndex = source.indexOf('const receiptId = await saveReceipt');
    const cleanupIndex = source.indexOf(
      'const nextDraftId = await completeSavedDraftAndGetNext'
    );
    const learningIndex = source.indexOf(
      'await applyReviewCorrectionsToLearning'
    );
    const postSaveIndex = source.indexOf(
      'await runPostSaveGrowthAnalysis(receiptId)'
    );
    const summaryNavigationIndex = source.indexOf(
      'buildPostSaveSummaryHref(receiptId, nextDraftId)'
    );

    expect(saveIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(saveIndex);
    expect(learningIndex).toBeGreaterThan(cleanupIndex);
    expect(postSaveIndex).toBeGreaterThan(learningIndex);
    expect(summaryNavigationIndex).toBeGreaterThan(postSaveIndex);
    expect(source).toContain('router.replace(');
  });

  it('contains no AI, paywall, payment, quota, or network integration', () => {
    const files = [
      path.resolve(__dirname, 'milestonePresentation.ts'),
      path.resolve(__dirname, '../app/post-save-summary/[receiptId].tsx'),
    ];
    const source = files
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    expect(source).not.toMatch(
      /Gemini|Supabase|supabase|fetch\(|paywall|StoreKit|purchase SDK|scan quota/
    );
  });
});
