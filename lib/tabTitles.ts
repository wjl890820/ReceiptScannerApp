/**
 * Tab label resolution for release UX (R2-B6).
 * i18n SSOT with English emergency fallback — never zh-only.
 */

export type TabTitleSet = {
  home: string;
  history: string;
  settings: string;
  analysis: string;
};

/** Emergency fallback when i18n throws or returns missing keys. */
export const TAB_TITLE_EMERGENCY_FALLBACK: TabTitleSet = {
  home: 'Home',
  history: 'History',
  settings: 'Settings',
  analysis: 'Analysis',
};

export function resolveTabTitles(
  translate: (key: string) => string
): TabTitleSet {
  try {
    const titles: TabTitleSet = {
      home: translate('tabs.home'),
      history: translate('tabs.history'),
      settings: translate('tabs.settings'),
      analysis: translate('tabs.analysis'),
    };
    for (const value of Object.values(titles)) {
      if (!value || value.startsWith('tabs.')) {
        return { ...TAB_TITLE_EMERGENCY_FALLBACK };
      }
    }
    return titles;
  } catch {
    return { ...TAB_TITLE_EMERGENCY_FALLBACK };
  }
}
