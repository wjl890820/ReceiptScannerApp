import {
  isTabBarActiveContrastSafe,
  TAB_BAR_PRESENTATION,
} from './tabBarPresentation';

describe('tab bar presentation contrast', () => {
  it('uses blue active and gray inactive on the shared near-white background', () => {
    expect(TAB_BAR_PRESENTATION.background.toLowerCase()).toBe('#f6f7f9');
    expect(TAB_BAR_PRESENTATION.active.toLowerCase()).not.toBe('#ffffff');
    expect(TAB_BAR_PRESENTATION.active.toLowerCase()).not.toBe('#fff');
    expect(TAB_BAR_PRESENTATION.inactive.toLowerCase()).not.toBe(
      TAB_BAR_PRESENTATION.background.toLowerCase()
    );
    expect(TAB_BAR_PRESENTATION.active.toLowerCase()).toBe('#1683ff');
    expect(TAB_BAR_PRESENTATION.inactive.toLowerCase()).toBe('#687076');
  });

  it('rejects white-on-white active state', () => {
    expect(
      isTabBarActiveContrastSafe({
        activeColor: '#ffffff',
        backgroundColor: '#ffffff',
      })
    ).toBe(false);
    expect(
      isTabBarActiveContrastSafe({
        activeColor: TAB_BAR_PRESENTATION.active,
        backgroundColor: TAB_BAR_PRESENTATION.background,
      })
    ).toBe(true);
  });

  it('tab layout binds the contrast-safe presentation tokens', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/_layout.tsx'),
      'utf8'
    );
    expect(source).toContain('TAB_BAR_PRESENTATION');
    expect(source).toContain('tabBarActiveTintColor: TAB_BAR_PRESENTATION.active');
    expect(source).toContain(
      'tabBarInactiveTintColor: TAB_BAR_PRESENTATION.inactive'
    );
    expect(source).toContain('tabBarShowLabel: true');
    expect(source).not.toMatch(/tabBarActiveTintColor:\s*Colors\[/);
  });
});
