import * as fs from 'fs';
import * as path from 'path';

import { resolveProgressiveHomeStage } from './homeProgressiveExperience';
import {
  buildHomeFrequentProductDetailHref,
  HOME_ANALYSIS_HREF,
  homeValueSurfaceFlags,
} from './homeValueHierarchy';

describe('homeValueSurfaceFlags (progressive disclosure)', () => {
  it('keeps Scan hero always and hides Analysis CTA on empty Home', () => {
    expect(homeValueSurfaceFlags('empty')).toEqual({
      showScanHero: true,
      showEmptyCopy: true,
      showLatestPurchase: false,
      showMilestoneProgress: false,
      showRecentInsight: false,
      showFrequentProducts: false,
      showProfile: false,
      showAnalysisCta: false,
    });
  });

  it('1-receipt (first): recent + progress + Analysis CTA, no frequent/profile', () => {
    expect(homeValueSurfaceFlags('first')).toMatchObject({
      showLatestPurchase: true,
      showMilestoneProgress: true,
      showRecentInsight: false,
      showFrequentProducts: false,
      showProfile: false,
      showAnalysisCta: true,
    });
  });

  it('3-receipt (recent): insight available, frequent still gated', () => {
    expect(homeValueSurfaceFlags('recent')).toMatchObject({
      showRecentInsight: true,
      showFrequentProducts: false,
      showProfile: false,
      showAnalysisCta: true,
    });
  });

  it('5-receipt (frequent): frequent products surface, no profile yet', () => {
    expect(homeValueSurfaceFlags('frequent')).toMatchObject({
      showRecentInsight: true,
      showFrequentProducts: true,
      showProfile: false,
    });
  });

  it('10+ receipt (profile): profile + frequent', () => {
    expect(homeValueSurfaceFlags('profile')).toMatchObject({
      showProfile: true,
      showFrequentProducts: true,
      showRecentInsight: false,
      showAnalysisCta: true,
    });
  });
});

describe('buildHomeFrequentProductDetailHref', () => {
  it('reuses the aggregatable Product Detail href contract', () => {
    expect(
      buildHomeFrequentProductDetailHref({
        groupingType: 'sku',
        key: 'sku-900',
      })
    ).toBe('/product/sku?key=sku-900');
    expect(
      buildHomeFrequentProductDetailHref({
        groupingType: 'canonical',
        key: '明治 おいしい牛乳',
      })
    ).toBe(
      '/product/canonical?key=' + encodeURIComponent('明治 おいしい牛乳')
    );
    expect(
      buildHomeFrequentProductDetailHref({
        groupingType: 'family',
        key: 'milk',
      })
    ).toBe('/product/family?key=milk');
    expect(
      buildHomeFrequentProductDetailHref({
        groupingType: 'personal_product',
        key: 'mp_anchor_123',
      })
    ).toBe('/product/personal_product?key=mp_anchor_123');
  });

  it('does not invent Product Detail routes for unresolved identities', () => {
    expect(
      buildHomeFrequentProductDetailHref({
        groupingType: 'sku',
        key: '   ',
      })
    ).toBeNull();
    expect(
      buildHomeFrequentProductDetailHref({
        // @ts-expect-error — unresolved identity must not navigate
        groupingType: 'occurrence',
        key: 'x',
      })
    ).toBeNull();
  });
});

describe('Home Analysis CTA + freeze proofs', () => {
  it('routes the Analysis CTA to the existing Analysis tab path', () => {
    expect(HOME_ANALYSIS_HREF).toBe('/analysis');
  });

  it('does not change milestone stage thresholds (0/1/2/3/5/10)', () => {
    expect(resolveProgressiveHomeStage(0)).toBe('empty');
    expect(resolveProgressiveHomeStage(1)).toBe('first');
    expect(resolveProgressiveHomeStage(2)).toBe('building');
    expect(resolveProgressiveHomeStage(3)).toBe('recent');
    expect(resolveProgressiveHomeStage(4)).toBe('recent');
    expect(resolveProgressiveHomeStage(5)).toBe('frequent');
    expect(resolveProgressiveHomeStage(9)).toBe('frequent');
    expect(resolveProgressiveHomeStage(10)).toBe('profile');
  });

  it('does not introduce merchant/spend-change recalculation on Home', () => {
    const hierarchy = fs.readFileSync(
      path.join(__dirname, 'homeValueHierarchy.ts'),
      'utf8'
    );
    const homeScreen = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    const insights = fs.readFileSync(
      path.join(__dirname, '../components/ProgressiveHomeInsights.tsx'),
      'utf8'
    );
    for (const source of [hierarchy, homeScreen, insights]) {
      expect(source).not.toMatch(/buildInsights\(/);
      expect(source).not.toMatch(/topMerchants/);
      expect(source).not.toMatch(/calculateStats\(/);
      expect(source).not.toMatch(/merchantAnalyticsKey/);
    }
  });
});
