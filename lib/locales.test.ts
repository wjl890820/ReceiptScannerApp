/**
 * Locale 完整性守护：
 *  - 三个 locale 文件必须是合法 JSON（防止尾随逗号等导致 Metro 打包/启动崩溃）。
 *  - 三语 key 必须完全一致（防止某语言缺 key 时 UI 直接显示原始 key）。
 */

import * as fs from 'fs';
import * as path from 'path';

const LOCALE_DIR = path.resolve(__dirname, '../locales');
const LOCALES = ['zh', 'ja', 'en'] as const;
const PRODUCT_FAMILIES = [
  'milk',
  'eggs',
  'tofu',
  'yogurt',
  'rice',
  'bread',
  'coffee',
  'tea',
  'water',
  'cola',
  'onigiri',
  'bento',
] as const;
const PRICE_HISTORY_KEYS = [
  'title',
  'subtitle.sku',
  'subtitle.canonical',
  'subtitle.family',
  'coverage',
  'flatUnchanged',
  'kind.purchase_unit',
  'kind.per_liter',
  'kind.per_100g',
  'kind.per_item',
  'status.notEnough',
  'status.noComparableSpec',
  'status.unsupportedFamily',
  'status.mixedCurrency',
  'status.ambiguousDimension',
] as const;

function loadLocale(name: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(LOCALE_DIR, `${name}.json`), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flattenKeys(v, key) : [key];
  });
}

function nestedString(obj: unknown, pathValue: string): string | null {
  let current = obj;
  for (const key of pathValue.split('.')) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim() ? current : null;
}

describe('locales integrity', () => {
  it('每个 locale 文件都是合法 JSON', () => {
    for (const name of LOCALES) {
      expect(() => loadLocale(name)).not.toThrow();
    }
  });

  it('三语 key 集合完全一致', () => {
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

  it('12 个 Product Family 都有三语用户标签', () => {
    for (const locale of LOCALES) {
      const translations = loadLocale(locale);
      for (const family of PRODUCT_FAMILIES) {
        const label = (
          (
            translations.productDetail as Record<string, unknown>
          ).family as Record<string, unknown>
        )[family];
        expect(typeof label).toBe('string');
        expect(String(label).trim()).not.toBe('');
        expect(label).not.toBe(family);
      }
    }
  });

  it('Price History 安全状态与单位都有三语文案', () => {
    for (const locale of LOCALES) {
      const translations = loadLocale(locale);
      for (const key of PRICE_HISTORY_KEYS) {
        expect(
          nestedString(translations, `priceHistory.${key}`)
        ).not.toBeNull();
      }
    }
  });
});
