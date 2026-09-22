/**
 * Round 6 — Home engagement dedup + hidden-stage suppression contracts.
 */

import * as fs from 'fs';
import * as path from 'path';

describe('Round 6 Home dedup / blur suppression (source contracts)', () => {
  const homeSource = fs.readFileSync(
    path.join(__dirname, '../app/(tabs)/index.tsx'),
    'utf8'
  );
  const engagementSource = fs.readFileSync(
    path.join(__dirname, 'engagementMilestones.ts'),
    'utf8'
  );
  const analysisSource = fs.readFileSync(
    path.join(__dirname, '../app/(tabs)/analysis.tsx'),
    'utf8'
  );
  const historySource = fs.readFileSync(
    path.join(__dirname, '../app/(tabs)/history/index.tsx'),
    'utf8'
  );

  it('Home uses selectAnalyticsReceiptsCached and passes preloaded engagement context', () => {
    expect(homeSource).toContain('selectAnalyticsReceiptsCached');
    expect(homeSource).toContain('buildEngagementPreloadedAnalyticsContext');
    expect(homeSource).toContain('preloaded');
    expect(homeSource).toContain('sharedProductInsight');
    expect(homeSource).toContain('shouldSkipExpensiveBuild');
    expect(homeSource).toContain('loadEngagementOwnerReceiptsWithDb');
    expect(homeSource).toContain('ownerKey: ownerScope.ownerKey');
    expect(homeSource).toContain('longTermAnalyticsReceipts');
    expect(homeSource).toContain('evaluateCurrentEngagementMilestone({ preloaded })');
    expect(homeSource).toContain('loadEngagementProductInsightContext({ preloaded })');
  });

  it('Home skips downstream stages when canApply/generation fails after list', () => {
    expect(homeSource).toMatch(
      /listReceipts[\s\S]*canApplyHomeUi[\s\S]*selectAnalyticsReceiptsCached/
    );
    expect(homeSource).toMatch(
      /selectAnalyticsReceiptsCached[\s\S]*canApplyHomeUi[\s\S]*Promise\.all/
    );
  });

  it('engagement APIs accept EngagementPreloadedAnalyticsContext', () => {
    expect(engagementSource).toContain('EngagementPreloadedAnalyticsContext');
    expect(engagementSource).toContain('sharedProductInsight');
    expect(engagementSource).toContain('preloadedMatchesOwner');
    expect(engagementSource).toContain('ownerKey');
    expect(engagementSource).toContain('selectAnalyticsReceiptsCached');
  });

  it('Analysis uses shared selection cache and skips after blur/supersede', () => {
    expect(analysisSource).toContain('selectAnalyticsReceiptsCached');
    expect(analysisSource).toContain('shouldSkipExpensiveBuild');
    expect(analysisSource).toContain("stage: 'after_list'");
    expect(analysisSource).toMatch(
      /name:\s*'blur'[\s\S]*loadCycleRef\.current\s*\+=\s*1/
    );
  });

  it('History uses load generation gate and selection cache', () => {
    expect(historySource).toContain('historyLoadGenerationRef');
    expect(historySource).toContain('buildHistoryPurchaseTruthView');
    expect(historySource).toContain('shouldSkipExpensiveBuild');
    expect(historySource).toContain('invalidateAsyncRequestGeneration(historyLoadGenerationRef)');
  });
});
