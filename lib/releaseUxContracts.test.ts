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
      path.join(__dirname, '../app/(tabs)/settings.tsx'),
      'utf8'
    );
    expect(settingsSource).toContain('shouldShowSettingsDevTools');
    expect(settingsSource).toContain('shouldShowAnalysisDDiagnosticsEntry');
    expect(settingsSource).toContain('shouldShowSettingsProEntry');
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
      path.join(__dirname, '../app/(tabs)/feedback.tsx'),
      'utf8'
    );
    expect(receiptDetail).toContain('navigateBackOrHistory');
    expect(productDetail).toContain('navigateBackOrHistory');
    expect(feedback).toContain('router.back');
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
});
