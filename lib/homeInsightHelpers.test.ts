// 只测试规则选择逻辑，不触发依赖 i18n/Localization 的部分
jest.mock('./categoryPalette', () => ({
  getCategoryLabel: (c: string) => c,
}));

import {
  type InsightContext,
  pickInsightRule,
  INSIGHT_RULES,
  buildHomeInsight,
} from './homeInsightHelpers';

function makeContext(partial: Partial<InsightContext>): InsightContext {
  return {
    totalSpending: 100,
    totalsByCategory: new Map(),
    top1Category: null,
    top1Pct: 0,
    top2Category: null,
    top2Pct: 0,
    uncategorizedPct: 0,
    nonEssentialPct: 0,
    avgReceiptTotal: 0,
    maxReceiptTotal: 0,
    ...partial,
  };
}

describe('homeInsightHelpers INSIGHT_RULES / pickInsightRule', () => {
  it('returns null when no rule matches', () => {
    const ctx = makeContext({
      top1Pct: 40, // 不够高不会触发 top1Pct>=50/60
      top2Pct: 0,
      uncategorizedPct: 15, // 介于 10 和 20 之间，不触发 65/70，也不满足 <=10 的均衡规则
      nonEssentialPct: 10, // <35，不触发非必需品规则
    });
    const rule = pickInsightRule(ctx);
    expect(rule).toBeNull();
  });

  it('picks high concentration rule when top1Pct >= 60', () => {
    const ctx = makeContext({ top1Pct: 65 });
    const rule = pickInsightRule(ctx);
    expect(rule).not.toBeNull();
    expect(rule?.priority).toBe(
      Math.max(...INSIGHT_RULES.map((r) => r.priority).filter((p) => p >= 100))
    );
  });

  it('respects priority when multiple rules match', () => {
    const ctx = makeContext({
      top1Pct: 55, // matches top1Pct>=50 rule
      nonEssentialPct: 50, // matches nonEssentialPct>=45 rule
    });
    const rule = pickInsightRule(ctx);
    expect(rule).not.toBeNull();

    const matched = INSIGHT_RULES.filter((r) => r.condition(ctx));
    const expectedTop = matched.sort((a, b) => b.priority - a.priority)[0];
    expect(rule).toBe(expectedTop);
  });
});

describe('homeInsightHelpers buildHomeInsight', () => {
  it('returns null when no rule matches', () => {
    const ctx = makeContext({
      top1Pct: 40,
      top2Pct: 0,
      uncategorizedPct: 15,
      nonEssentialPct: 10,
    });

    expect(buildHomeInsight(ctx, null)).toBeNull();
  });

  it('returns insight when single rule matches (priority=100)', () => {
    const ctx = makeContext({
      top1Pct: 65,
      top2Pct: 0,
      uncategorizedPct: 0,
      nonEssentialPct: 0,
    });

    const insight = buildHomeInsight(ctx, null);
    expect(insight).not.toBeNull();
    expect(insight?.code).toBe(100);
    expect(insight?.level).toBe('alert');
  });

  it('picks highest priority when multiple rules match', () => {
    const ctx = makeContext({
      top1Pct: 70, // triggers priority=100 and 90
      top2Pct: 0,
      uncategorizedPct: 40, // may trigger uncategorized rules too
      nonEssentialPct: 50, // may trigger nonEssential rules too
    });

    const insight = buildHomeInsight(ctx, null);
    expect(insight).not.toBeNull();
    expect(insight?.code).toBe(100);
  });
});

