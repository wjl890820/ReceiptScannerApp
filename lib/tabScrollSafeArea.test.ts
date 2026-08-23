/**
 * Tab scroll / status-bar layout contract (R2-F1).
 *
 * Safe-area top inset must live on a non-scrolling outer container so
 * scrolled content cannot paint under the iOS status bar. Padding on
 * ScrollView contentContainerStyle alone is insufficient.
 */

import * as fs from 'fs';
import * as path from 'path';

function readScreen(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('R2-F1 tab status-bar scroll layout', () => {
  it('Home keeps insets.top on a non-scrolling outer View', () => {
    const source = readScreen('app/(tabs)/index.tsx');
    expect(source).toContain('useSafeAreaInsets');
    expect(source).toContain('paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap');
    // Outer screen container owns the inset (History-proven pattern).
    expect(source).toMatch(
      /style=\{\[\s*styles\.screenContainer,\s*\{\s*paddingTop:\s*insets\.top \+ UI_LAYOUT\.safeAreaTopGap/
    );
    // Must not put the safe-area inset on ScrollView content padding.
    expect(source).not.toMatch(
      /contentContainerStyle=\{\[[\s\S]*?paddingTop:\s*insets\.top/
    );
  });

  it('Analysis keeps insets.top on a non-scrolling outer View', () => {
    const source = readScreen('app/(tabs)/analysis.tsx');
    expect(source).toContain('useSafeAreaInsets');
    expect(source).toContain('paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap');
    expect(source).toMatch(
      /style=\{\[\s*styles\.screen,\s*\{\s*paddingTop:\s*insets\.top \+ UI_LAYOUT\.safeAreaTopGap/
    );
    expect(source).not.toMatch(
      /contentContainerStyle=\{\[[\s\S]*?paddingTop:\s*insets\.top/
    );
  });

  it('History already uses the non-scrolling outer inset pattern', () => {
    const source = readScreen('app/(tabs)/history/index.tsx');
    expect(source).toMatch(
      /style=\{\[\s*styles\.container,\s*\{\s*paddingTop:\s*insets\.top \+ UI_LAYOUT\.safeAreaTopGap/
    );
  });
});
