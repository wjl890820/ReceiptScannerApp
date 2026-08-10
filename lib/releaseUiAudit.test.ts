/**
 * Phase 5F — Release UI audit tests (static + presentation helpers).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  RELEASE_LOCALE_EXCLUDE_POLICY,
  findForbiddenTerms,
  pathIsExcludedFromReleaseAudit,
} from './releaseUiAudit';
import { shouldShowLegacyPriceRadar } from './analysisPresentation';
import { ENGAGEMENT_MILESTONES } from './engagementMilestones';
import {
  resolveInstalledAppMetadata,
  shouldShowSettingsDevTools,
  shouldShowSettingsProEntry,
} from './settingsPresentation';
import { buildAnalysisInsightPresentation } from './analysisPresentation';
import { createEmptyStats } from './analysisHelpers';

const ROOT = path.resolve(__dirname, '..');
const LOCALE_DIR = path.join(ROOT, 'locales');
const LOCALES = ['zh', 'ja', 'en'] as const;

/** Normal-user facing presentation roots (no Dev Tools / tests). */
const RELEASE_SCAN_ROOTS = [
  'app/(tabs)/index.tsx',
  'app/(tabs)/analysis.tsx',
  'app/(tabs)/history',
  'app/(tabs)/feedback.tsx',
  'app/(tabs)/_layout.tsx',
  'app/scan-review',
  'app/post-save-summary',
  'app/product',
  'components',
  'lib/analysisPresentation.ts',
  'lib/homeProgressiveExperience.ts',
  'lib/scanReviewPresentation.ts',
  'lib/settingsPresentation.ts',
  'lib/engagementMilestones.ts',
];

function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flattenKeys(v, key) : [key];
  });
}

function loadLocale(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALE_DIR, `${name}.json`), 'utf8')
  ) as Record<string, unknown>;
}

function nestedString(obj: unknown, pathValue: string): string | null {
  let current = obj;
  for (const key of pathValue.split('.')) {
    if (!current || typeof current !== 'object' || !(key in current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}

function walkFiles(absDir: string, out: string[] = []): string[] {
  if (!fs.existsSync(absDir)) return out;
  const st = fs.statSync(absDir);
  if (st.isFile()) {
    out.push(absDir);
    return out;
  }
  for (const name of fs.readdirSync(absDir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    walkFiles(path.join(absDir, name), out);
  }
  return out;
}

function collectReleaseSourceFiles(): string[] {
  const files: string[] = [];
  for (const rel of RELEASE_SCAN_ROOTS) {
    walkFiles(path.join(ROOT, rel), files);
  }
  return files.filter((f) => {
    if (!/\.(tsx|ts)$/.test(f)) return false;
    if (pathIsExcludedFromReleaseAudit(f)) return false;
    if (f.includes('.test.')) return false;
    return true;
  });
}

describe('release UI audit — locale parity', () => {
  it('documents exclude policy for Dev-only copy', () => {
    expect(RELEASE_LOCALE_EXCLUDE_POLICY.length).toBeGreaterThan(20);
  });

  it('zh/ja/en formal keys are identical (missing any locale fails)', () => {
    const keySets = LOCALES.map((name) => new Set(flattenKeys(loadLocale(name))));
    const union = new Set<string>();
    for (const s of keySets) for (const k of s) union.add(k);
    const missing: string[] = [];
    LOCALES.forEach((name, i) => {
      for (const k of union) {
        if (!keySets[i].has(k)) missing.push(`${name} missing: ${k}`);
      }
    });
    expect(missing).toEqual([]);
  });

  it('privacy alerts do not mention PRIVACY_POLICY.md', () => {
    for (const name of LOCALES) {
      const alert = nestedString(loadLocale(name), 'settings.privacy.alert') || '';
      expect(alert).not.toContain('PRIVACY_POLICY.md');
    }
  });
});

describe('release UI audit — gates', () => {
  it('hides Settings Developer Tools for normal Release users', () => {
    expect(shouldShowSettingsDevTools(false, false)).toBe(false);
    expect(shouldShowSettingsDevTools(true, false)).toBe(true);
    expect(shouldShowSettingsDevTools(false, true)).toBe(true);
  });

  it('hides Coming Soon Pro from Settings', () => {
    expect(shouldShowSettingsProEntry({ comingSoon: true })).toBe(false);
  });

  it('hides legacy Price Radar from Analysis release', () => {
    expect(
      shouldShowLegacyPriceRadar({ migratedToSafePriceHistory: false })
    ).toBe(false);
  });

  it('pro-insight route is gated by the same coming-soon flag', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'app/(tabs)/pro-insight.tsx'),
      'utf8'
    );
    expect(source).toContain('shouldShowSettingsProEntry');
    expect(source).toContain('PRO_COMING_SOON');
    expect(source).toContain("router.replace('/(tabs)/settings')");
  });

  it('uncategorized-items route requires Dev Tools unlock', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'app/(tabs)/uncategorized-items.tsx'),
      'utf8'
    );
    expect(source).toContain('isDevToolsUnlocked');
    expect(source).toContain('devTools.gateTitle');
  });
});

describe('release UI audit — milestones / version / analysis copy', () => {
  it('formal milestone thresholds are 1/3/5/10 only', () => {
    expect([...ENGAGEMENT_MILESTONES]).toEqual([1, 3, 5, 10]);
    expect(ENGAGEMENT_MILESTONES).not.toContain(20);
  });

  it('progressive locales do not advertise milestone 20', () => {
    for (const name of LOCALES) {
      const home = loadLocale(name).home as Record<string, unknown>;
      const progressive = JSON.stringify(home.progressive ?? {});
      expect(progressive).not.toMatch(/解锁\s*20|x\/20/i);
      expect(progressive).not.toContain('/20');
    }
  });

  it('version presentation helper does not hardcode build 15 / 1.0.5', () => {
    const meta = resolveInstalledAppMetadata({
      nativeAppVersion: '9.9.9',
      nativeBuildVersion: '99',
      expoConfig: { version: '8.8.8', ios: { buildNumber: '88' }, name: 'Receipt Scanner' },
    });
    expect(meta.version).toBe('9.9.9');
    expect(meta.build).toBe('99');
    const helperSource = fs.readFileSync(
      path.join(ROOT, 'lib/settingsPresentation.ts'),
      'utf8'
    );
    expect(helperSource).not.toMatch(/['"]1\.0\.5['"]/);
    expect(helperSource).not.toMatch(/['"]15['"]/);
  });

  it('Analysis release insights use analysis.release keys (not analysisV2.story)', () => {
    const stats = {
      ...createEmptyStats(),
      supportedSpend: 1000,
      supportedReceiptCount: 5,
      topCategories: [{ category: 'food_ingredients', amount: 600 }],
    };
    const insight = buildAnalysisInsightPresentation('ready', stats, {
      type: 'full',
      conclusionKey: 'analysisV2.story.conclusion',
      conclusionParams: { cat: 'food_ingredients', pct: 60, amt: 600 },
      explanationKey: 'analysisV2.story.explainDefault',
    });
    expect(insight?.bodyKey).toBe('analysis.release.topCategoryInsight');
    expect(insight?.bodyKey).not.toContain('analysisV2');
  });
});

describe('release UI audit — engineering term leakage', () => {
  it('keeps Settings forbid-token guardrail for release rows', () => {
    const {
      SETTINGS_RELEASE_FORBIDDEN_TOKENS,
    } = require('./settingsPresentation') as typeof import('./settingsPresentation');
    expect(SETTINGS_RELEASE_FORBIDDEN_TOKENS).toEqual(
      expect.arrayContaining([
        'trace_id',
        'normalized_name',
        'product_dictionary',
        'currentVersion',
        'currentBuild',
        'devToolsEnabled',
      ])
    );
  });

  it('release-facing locale values do not equal raw engineering enums', () => {
    for (const name of LOCALES) {
      const loc = loadLocale(name);
      expect(nestedString(loc, 'scanReview.traceId')).not.toMatch(/trace_id/i);
      expect(nestedString(loc, 'priceHistory.status.ambiguousDimension')).not.toBe(
        'ambiguous_dimension'
      );
      expect(nestedString(loc, 'priceHistory.status.mixedCurrency')).not.toBe(
        'mixed_currency'
      );
      expect(nestedString(loc, 'settings.privacy.alert')).not.toContain('PRIVACY_POLICY.md');
    }
  });

  it('normal presentation JSX avoids obvious engineering labels in user copy', () => {
    const files = collectReleaseSourceFiles().filter((f) => {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (rel.startsWith('lib/')) return false;
      return /\.tsx$/.test(rel);
    });
    const offenders: string[] = [];
    const uiTerms = [
      'trace_id',
      'normalized_name',
      'product_dictionary',
      'classification_telemetry',
      'currentVersion',
      'currentBuild',
      'devToolsEnabled',
      'ambiguous_dimension',
      'mixed_currency',
    ] as const;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const chunks = [
        ...(source.match(/>\s*[^<{]+?\s*</g) || []),
        ...(source.match(
          /(?:title|message|placeholder|accessibilityLabel)\s*[:=]\s*['"`][^'"`]+['"`]/g
        ) || []),
        ...(source.match(/Alert\.alert\(\s*['"`][^'"`]+['"`]/g) || []),
      ];
      const joined = chunks.join('\n');
      const hits = findForbiddenTerms(joined, uiTerms);
      if (hits.length) {
        offenders.push(`${path.relative(ROOT, file)}: ${hits.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('release UI audit — native permission locales', () => {
  it('ships ja / zh-Hans / en InfoPlist usage strings', () => {
    for (const name of ['ja', 'zh-Hans', 'en'] as const) {
      const file = path.join(LOCALE_DIR, 'native', `${name}.json`);
      expect(fs.existsSync(file)).toBe(true);
      const json = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        ios?: Record<string, string>;
      };
      expect(json.ios?.NSCameraUsageDescription?.trim()).toBeTruthy();
      expect(json.ios?.NSPhotoLibraryUsageDescription?.trim()).toBeTruthy();
    }
    const appJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')
    ) as { expo: { locales?: Record<string, string>; ios?: { infoPlist?: Record<string, unknown> } } };
    expect(appJson.expo.locales?.ja).toContain('locales/native/ja.json');
    expect(appJson.expo.locales?.['zh-Hans']).toContain('locales/native/zh-Hans.json');
    expect(appJson.expo.locales?.en).toContain('locales/native/en.json');
    expect(appJson.expo.ios?.infoPlist?.CFBundleAllowMixedLocalizations).toBe(true);
  });
});
