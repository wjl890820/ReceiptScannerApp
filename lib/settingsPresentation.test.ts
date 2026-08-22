import * as fs from 'fs';
import * as path from 'path';

import {
  canUnlockDevToolsViaSecretTap,
  formatAboutVersionLine,
  localePreferenceLabelKey,
  resolveInstalledAppMetadata,
  SETTINGS_RELEASE_FORBIDDEN_TOKENS,
  shouldShowSettingsDevTools,
  shouldShowSettingsProEntry,
} from './settingsPresentation';

describe('settings release visibility', () => {
  it('hides Dev Tools for normal release users', () => {
    expect(shouldShowSettingsDevTools(false, false)).toBe(false);
  });

  it('shows Dev Tools when unlocked or in a development build', () => {
    expect(shouldShowSettingsDevTools(true, false)).toBe(true);
    expect(shouldShowSettingsDevTools(false, true)).toBe(true);
    expect(shouldShowSettingsDevTools(true, true)).toBe(true);
  });

  it('blocks secret tap unlock outside development builds', () => {
    expect(canUnlockDevToolsViaSecretTap(false)).toBe(false);
    expect(canUnlockDevToolsViaSecretTap(true)).toBe(true);
  });

  it('hides coming-soon Pro from the release Settings list', () => {
    expect(shouldShowSettingsProEntry({ comingSoon: true })).toBe(false);
    expect(shouldShowSettingsProEntry({ comingSoon: false })).toBe(true);
  });
});

describe('settings version/build presentation', () => {
  it('prefers native installed metadata over config version fallback', () => {
    expect(
      resolveInstalledAppMetadata({
        nativeAppVersion: '1.0.5',
        nativeBuildVersion: '20',
        expoConfig: {
          version: '1.0.4',
          name: 'Receipt Scanner',
          ios: { buildNumber: '15' },
        },
      })
    ).toEqual({
      name: 'Receipt Scanner',
      version: '1.0.5',
      build: '20',
    });
  });

  it('never presents stale expoConfig buildNumber as installed build', () => {
    expect(
      resolveInstalledAppMetadata({
        nativeAppVersion: '1.0.5',
        nativeBuildVersion: null,
        expoConfig: {
          version: '1.0.5',
          name: 'Receipt Scanner',
          ios: { buildNumber: '15' },
        },
      })
    ).toEqual({
      name: 'Receipt Scanner',
      version: '1.0.5',
      build: '—',
    });
  });

  it('falls back safely when metadata is missing', () => {
    expect(resolveInstalledAppMetadata({})).toEqual({
      name: 'Receipt Scanner',
      version: '—',
      build: '—',
    });
    expect(formatAboutVersionLine('1.0.5', '20')).toBe('1.0.5 (20)');
    expect(formatAboutVersionLine('1.0.5', '—')).toBe('1.0.5');
    expect(formatAboutVersionLine('unknown', 'unknown')).toBe('—');
  });

  it('does not hardcode build 15/20 in Settings presentation helpers or screen', () => {
    const files = [
      path.resolve(__dirname, 'settingsPresentation.ts'),
      path.resolve(__dirname, '../app/(tabs)/settings.tsx'),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/['"]15['"]/);
      expect(source).not.toMatch(/['"]20['"]/);
      expect(source).not.toMatch(/hardcode.*1\.0\.5|version\s*=\s*['"]1\.0\.5['"]/i);
    }
  });
});


describe('settings language labels', () => {
  it('maps preferences to localized label keys', () => {
    expect(localePreferenceLabelKey('system')).toBe(
      'settings.language.options.system'
    );
    expect(localePreferenceLabelKey('zh')).toBe(
      'settings.language.options.zh'
    );
    expect(localePreferenceLabelKey('ja')).toBe(
      'settings.language.options.ja'
    );
    expect(localePreferenceLabelKey('en')).toBe(
      'settings.language.options.en'
    );
  });
});

describe('settings release surface contracts', () => {
  const settingsSource = fs.readFileSync(
    path.resolve(__dirname, '../app/(tabs)/settings.tsx'),
    'utf8'
  );

  it('keeps the normal user tree free of engineering tokens', () => {
    const jsxStart = settingsSource.indexOf('return (\n    <ScrollView');
    expect(jsxStart).toBeGreaterThan(-1);
    const releaseTree =
      settingsSource.slice(jsxStart).split('{showDevTools ?')[0] ?? '';
    for (const token of SETTINGS_RELEASE_FORBIDDEN_TOKENS) {
      expect(releaseTree).not.toContain(token);
    }
    expect(settingsSource).toContain(
      'shouldShowSettingsProEntry({ comingSoon: true })'
    );
  });

  it('keeps Dev Tools code and only gates visibility / unlock', () => {
    expect(settingsSource).toContain('shouldShowSettingsDevTools');
    expect(settingsSource).toContain('canUnlockDevToolsViaSecretTap');
    expect(settingsSource).toContain('expo-application');
    expect(settingsSource).toContain('Developer Tools');
    expect(settingsSource).toContain('Product dictionary stats');
    expect(settingsSource).toContain('runReclassifyExistingReceipts');
    expect(settingsSource).toContain('Default receipt source');
    expect(settingsSource).toContain('DEV_TOOLS_ENABLED_KEY');
    expect(settingsSource).toContain('Hide Dev Tools');
  });

  it('gates Analysis D diagnostics behind the validation flag helper', () => {
    expect(settingsSource).toContain('shouldShowAnalysisDDiagnosticsEntry');
    expect(settingsSource).toContain('isAnalysisDDiagnosticsEnabled');
    expect(settingsSource).toContain('showAnalysisDDiagnostics');
    expect(settingsSource).toContain('Analysis D Diagnostics');
  });

  it('does not introduce payment or quota code', () => {
    expect(settingsSource).not.toMatch(
      /StoreKit|purchase|paywall|scan.?quota|IAP/i
    );
  });
});
