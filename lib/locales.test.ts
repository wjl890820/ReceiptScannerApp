/**
 * Locale 完整性守护：
 *  - 三个 locale 文件必须是合法 JSON（防止尾随逗号等导致 Metro 打包/启动崩溃）。
 *  - 三语 key 必须完全一致（防止某语言缺 key 时 UI 直接显示原始 key）。
 */

import * as fs from 'fs';
import * as path from 'path';

const LOCALE_DIR = path.resolve(__dirname, '../locales');
const LOCALES = ['zh', 'ja', 'en'] as const;

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
});
