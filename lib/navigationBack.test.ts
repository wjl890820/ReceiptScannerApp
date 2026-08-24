import {
  HISTORY_TAB_FALLBACK_HREF,
  HOME_TAB_FALLBACK_HREF,
  SETTINGS_TAB_FALLBACK_HREF,
  navigateBackOrFallback,
  navigateBackOrHistory,
  navigateBackOrHome,
  navigateBackOrSettings,
} from './navigationBack';

describe('navigateBackOrFallback', () => {
  it('uses router.back when stack history exists', () => {
    const back = jest.fn();
    const replace = jest.fn();
    navigateBackOrFallback(
      { canGoBack: () => true, back, replace },
      HISTORY_TAB_FALLBACK_HREF
    );
    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not hardcode Home as the only fallback', () => {
    const back = jest.fn();
    const replace = jest.fn();
    navigateBackOrFallback(
      { canGoBack: () => false, back, replace },
      HISTORY_TAB_FALLBACK_HREF
    );
    expect(replace).toHaveBeenCalledWith(HISTORY_TAB_FALLBACK_HREF);
    expect(replace).not.toHaveBeenCalledWith(HOME_TAB_FALLBACK_HREF);
  });
});

describe('navigateBackOrHistory', () => {
  it('uses router.back when history exists', () => {
    const back = jest.fn();
    const replace = jest.fn();
    navigateBackOrHistory({ canGoBack: () => true, back, replace });
    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('falls back to History when there is no stack entry', () => {
    const back = jest.fn();
    const replace = jest.fn();
    navigateBackOrHistory({ canGoBack: () => false, back, replace });
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(HISTORY_TAB_FALLBACK_HREF);
  });
});

describe('navigateBackOrHome / navigateBackOrSettings', () => {
  it('product deep-link fallback is Home, not History', () => {
    const replace = jest.fn();
    navigateBackOrHome({
      canGoBack: () => false,
      back: jest.fn(),
      replace,
    });
    expect(replace).toHaveBeenCalledWith(HOME_TAB_FALLBACK_HREF);
  });

  it('settings subordinate fallback is Settings', () => {
    const replace = jest.fn();
    navigateBackOrSettings({
      canGoBack: () => false,
      back: jest.fn(),
      replace,
    });
    expect(replace).toHaveBeenCalledWith(SETTINGS_TAB_FALLBACK_HREF);
  });
});

describe('Build 53 navigation wiring', () => {
  it('History list does not hardcode Home as detail back target', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const detail = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/[id].tsx'),
      'utf8'
    );
    expect(detail).toContain('navigateBackOrHistory');
    expect(detail).not.toMatch(
      /navigateBackOrHistory[\s\S]{0,80}replace\(\s*['"`]\/(?:\(tabs\)\/)?['"`]/
    );
    expect(detail).not.toContain("replace('/(tabs)/')");
    expect(detail).not.toContain('replace("/")');
  });

  it('History uses nested Stack layout for push + edge swipe', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const historyLayout = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/history/_layout.tsx'),
      'utf8'
    );
    const tabsLayout = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/_layout.tsx'),
      'utf8'
    );
    const rootLayout = fs.readFileSync(
      path.join(__dirname, '../app/_layout.tsx'),
      'utf8'
    );
    expect(historyLayout).toContain('gestureEnabled: true');
    expect(historyLayout).toContain('Stack');
    expect(tabsLayout).toContain('name="history"');
    expect(tabsLayout).not.toContain('name="history/[id]"');
    expect(rootLayout).toContain('gestureEnabled: true');
  });

  it('Product Detail prefers stack back; deep-link fallback is Home', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const product = fs.readFileSync(
      path.join(__dirname, '../app/product/[targetType].tsx'),
      'utf8'
    );
    expect(product).toContain('navigateBackOrHome');
  });

  it('Scan Review beforeRemove covers edge-swipe pop', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const review = fs.readFileSync(
      path.join(__dirname, '../app/scan-review/[draftId].tsx'),
      'utf8'
    );
    expect(review).toContain("addListener('beforeRemove'");
    expect(review).toContain('leaveGuardBaseRef');
  });
});
