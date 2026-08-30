import * as fs from 'fs';
import * as path from 'path';

import {
  canUnlockDevToolsViaSecretTap,
  shouldShowSettingsDevTools,
  shouldShowSettingsProEntry,
} from './settingsPresentation';
import {
  resolveTabTitles,
  TAB_TITLE_EMERGENCY_FALLBACK,
} from './tabTitles';
import { UI_LAYOUT } from './uiTokens';

const localesDir = path.resolve(__dirname, '../locales');

function readLocale(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf8')
  ) as Record<string, unknown>;
}

function nested(obj: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

describe('R2-B6 release UX contracts', () => {
  it('A — production/default diagnostics visibility is OFF', () => {
    const accessSource = fs.readFileSync(
      path.join(__dirname, 'analysisDDiagnosticsAccess.ts'),
      'utf8'
    );
    const envSource = fs.readFileSync(path.join(__dirname, 'env.ts'), 'utf8');
    expect(accessSource).toContain(
      'export function shouldShowAnalysisDDiagnosticsEntry'
    );
    expect(accessSource).toMatch(
      /return diagnosticsEnabled === true|return enabled === true/
    );
    expect(envSource).toContain('isAnalysisDDiagnosticsEnabled');
    expect(envSource).toContain('return false;');
  });

  it('B — internal/dev Settings rows stay gated in production/default', () => {
    expect(shouldShowSettingsDevTools(false, false)).toBe(false);
    expect(canUnlockDevToolsViaSecretTap(false)).toBe(false);
    expect(shouldShowSettingsProEntry({ comingSoon: true })).toBe(false);

    const settingsSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
      'utf8'
    );
    expect(settingsSource).toContain('shouldShowSettingsDevTools');
    expect(settingsSource).toContain('shouldShowAnalysisDDiagnosticsEntry');
    expect(settingsSource).toContain('shouldShowSettingsProEntry');
    // Receipts DB JSON export must remain development-build-only.
    expect(settingsSource).toContain('exportAndShareReceiptsDb');
    expect(settingsSource).toMatch(
      /\{__DEV__\s*\?[\s\S]*Export receipts DB \(JSON\)/
    );
  });

  it('C — tab labels resolve through i18n for en/zh/ja', () => {
    for (const locale of ['en', 'zh', 'ja'] as const) {
      const data = readLocale(locale);
      const tabs = data.tabs as Record<string, string>;
      expect(typeof tabs.home).toBe('string');
      expect(typeof tabs.history).toBe('string');
      expect(typeof tabs.settings).toBe('string');
      expect(typeof tabs.analysis).toBe('string');
      expect(tabs.home.length).toBeGreaterThan(0);
    }

    const en = readLocale('en').tabs as Record<string, string>;
    const zh = readLocale('zh').tabs as Record<string, string>;
    const ja = readLocale('ja').tabs as Record<string, string>;
    expect(en.home).toBe('Home');
    expect(zh.home).toBe('首页');
    expect(ja.home).toBe('ホーム');

    const layoutSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/_layout.tsx'),
      'utf8'
    );
    expect(layoutSource).toContain('resolveTabTitles');
    expect(layoutSource).not.toContain("'首页'");
  });

  it('D — disabled diagnostics route does not render report UI', () => {
    const screen = fs.readFileSync(
      path.join(__dirname, '../app/analysis-d-diagnostics.tsx'),
      'utf8'
    );
    expect(screen).toContain('isAnalysisDDiagnosticsEnabled');
    expect(screen).toContain('if (!enabled)');
    expect(screen).toContain('router.back');
    expect(screen).toContain('Disabled in this build');
  });

  it('E — production copy exists in all 3 locales', () => {
    for (const locale of ['en', 'zh', 'ja'] as const) {
      const data = readLocale(locale);
      for (const key of [
        'feedback.back',
        'feedback.title',
        'feedback.submit',
        'feedback.submitting',
        'postSaveSummary.fallback',
        'postSaveSummary.done',
        'tabs.home',
        'tabs.history',
        'tabs.settings',
        'tabs.analysis',
      ]) {
        const value = nested(data, key);
        expect(typeof value).toBe('string');
        expect(String(value).length).toBeGreaterThan(0);
      }
    }
  });

  it('F — navigation/back fallbacks remain present on detail surfaces', () => {
    const receiptDetail = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/[id].tsx'),
      'utf8'
    );
    const productDetail = fs.readFileSync(
      path.join(__dirname, '../app/product/[targetType].tsx'),
      'utf8'
    );
    const feedback = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/settings/feedback.tsx'),
      'utf8'
    );
    expect(receiptDetail).toContain('navigateBackOrHistory');
    expect(productDetail).toContain('navigateBackOrHome');
    expect(feedback).toContain('navigateBackOrSettings');
    // Internal targetType is not a user-facing badge (avoids raw i18n keys).
    expect(productDetail).not.toContain('productDetail.targetType.');
  });

  it('G — domain helper modules remain present; layout tokens stable', () => {
    expect(fs.existsSync(path.join(__dirname, 'analysisDReport.ts'))).toBe(
      true
    );
    expect(
      fs.existsSync(path.join(__dirname, 'analysisDDuplicateAudit.ts'))
    ).toBe(true);
    expect(UI_LAYOUT.tabContentClearance).toBe(72);
    expect(UI_LAYOUT.controlMinHeight).toBe(44);
  });

  it('tab title helper falls back to English emergency labels', () => {
    expect(
      resolveTabTitles(() => {
        throw new Error('i18n down');
      })
    ).toEqual(TAB_TITLE_EMERGENCY_FALLBACK);
    expect(resolveTabTitles((key) => key)).toEqual(
      TAB_TITLE_EMERGENCY_FALLBACK
    );
  });

  it('H — Build 52: no raw productDetail.targetType / merchant_product badge leakage', () => {
    const productDetail = fs.readFileSync(
      path.join(__dirname, '../app/product/[targetType].tsx'),
      'utf8'
    );
    expect(productDetail).not.toContain('productDetail.targetType.');
    expect(productDetail).not.toMatch(
      /t\(['"]productDetail\.targetType/
    );
    // Internal badge copy must not surface merchant_product as user UI.
    const badgeSnippet = productDetail.match(
      /targetType|merchant_product|SKU_EXACT|family_spec/
    );
    // Route param name targetType is OK; user-visible badge keys are not.
    expect(productDetail).not.toContain('merchant_product');
    expect(badgeSnippet?.[0] === 'merchant_product').toBeFalsy();
  });

  it('I — Build 52: Frequent quantity omits unreliable zero; no viewHistory duplicate CTA', () => {
    const homeFrequent = fs.readFileSync(
      path.join(__dirname, '../components/home/HomeFrequentProductList.tsx'),
      'utf8'
    );
    const home = fs.readFileSync(
      path.join(__dirname, '../components/ProgressiveHomeInsights.tsx'),
      'utf8'
    );
    expect(homeFrequent).toContain('totalPurchaseQuantity > 0');
    expect(home).not.toContain('home.progressive.frequent.viewHistory');
    // Duplicate Analysis-tab CTA removed from Home JSX (styles/dead props OK).
    expect(home).not.toContain("t('home.progressive.analysisCta'");
    expect(home).not.toContain('onViewAnalysis()');
    const progressive = fs.readFileSync(
      path.join(__dirname, 'homeProgressiveExperience.ts'),
      'utf8'
    );
    // Identity path must pass through real aggregate quantity (not hardcode 0).
    expect(progressive).not.toMatch(/totalPurchaseQuantity:\s*0\b/);
  });

  it('J — Build 52: merchant-local price wording + product-scoped coverage keys', () => {
    for (const locale of ['zh', 'ja', 'en'] as const) {
      const data = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, `../locales/${locale}.json`),
          'utf8'
        )
      ) as Record<string, unknown>;
      const ph = data.priceHistory as Record<string, unknown>;
      expect(typeof ph.coverageComparable).toBe('string');
      expect(String(ph.coverageComparable)).toContain('{comparable}');
      expect(String(ph.coverageComparable)).not.toContain('{total}');
      expect(typeof ph.coverageExcludedCurrent).toBe('string');
      expect(typeof ph.titleMerchantLocal).toBe('string');
      expect(String(ph.titleMerchantLocal).length).toBeGreaterThan(0);
    }
    expect(
      JSON.parse(
        fs.readFileSync(path.join(__dirname, '../locales/zh.json'), 'utf8')
      ).priceHistory.titleMerchantLocal
    ).toContain('在这家店');
    expect(
      JSON.parse(
        fs.readFileSync(path.join(__dirname, '../locales/ja.json'), 'utf8')
      ).priceHistory.titleMerchantLocal
    ).toContain('この店舗');
    expect(
      JSON.parse(
        fs.readFileSync(path.join(__dirname, '../locales/en.json'), 'utf8')
      ).priceHistory.titleMerchantLocal
    ).toMatch(/this store/i);
    const chart = fs.readFileSync(
      path.join(__dirname, '../components/ProductPriceHistoryChart.tsx'),
      'utf8'
    );
    expect(chart).toContain('priceHistory.coverageComparable');
    expect(chart).not.toContain('priceHistory.coverageExcludedCurrent');
    expect(chart).not.toMatch(/t\(['"]priceHistory\.coverage['"]/);
  });

  it('K — Build 52: merchant accent helper is deterministic and palette-bounded', () => {
    const {
      merchantAccentColor,
      merchantAccentIndex,
    } = require('./merchantAccent') as typeof import('./merchantAccent');
    expect(merchantAccentColor('ヨークベニマル')).toBe(
      merchantAccentColor('ヨークベニマル')
    );
    expect(merchantAccentIndex('costco')).toBeGreaterThanOrEqual(0);
    expect(merchantAccentIndex('costco')).toBeLessThan(8);
    expect(merchantAccentColor('')).toBe(merchantAccentColor('   '));
  });

  it('L — Build 52: user routes avoid known engineering identifier copy', () => {
    const screens = [
      '../components/ProgressiveHomeInsights.tsx',
      '../app/(tabs)/analysis.tsx',
      '../app/(tabs)/history/index.tsx',
      '../app/product/[targetType].tsx',
      '../app/(tabs)/settings/index.tsx',
    ];
    const banned = [
      'resolverVersion',
      'comparisonKey',
      'eligible observation',
      'SKU_EXACT',
      'family_spec',
      'Gemini model',
      'semantic cache',
    ];
    for (const rel of screens) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      for (const term of banned) {
        expect(src).not.toContain(term);
      }
    }
  });
});
