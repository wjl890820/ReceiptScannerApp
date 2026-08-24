import {
  merchantAccentColor,
  merchantAccentIndex,
  merchantAccentPaletteForTests,
} from './merchantAccent';

describe('merchantAccent V2', () => {
  it('is deterministic for the same normalized key', () => {
    expect(merchantAccentColor('ヨークベニマル')).toBe(
      merchantAccentColor('ヨークベニマル')
    );
    expect(merchantAccentIndex('costco')).toBe(merchantAccentIndex('costco'));
  });

  it('maps equal normalized keys to the same accent', () => {
    expect(merchantAccentColor('aeon')).toBe(merchantAccentColor('aeon'));
  });

  it('returns a palette color even for empty input', () => {
    expect(merchantAccentColor('')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(merchantAccentColor(null)).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('uses a mature multi-hue palette with distinct entries', () => {
    const palette = merchantAccentPaletteForTests();
    expect(palette).toHaveLength(8);
    expect(new Set(palette).size).toBe(8);
  });
});
