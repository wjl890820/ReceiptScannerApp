/**
 * backfill 纯函数测试：旧分类/缺失分类 → 新分类；幂等。
 * 仅测试 fixJsonItems，不触碰 SQLite。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({}));
jest.mock('./db', () => ({ initIfNeeded: jest.fn() }));

import { fixJsonItems } from './categoryBackfill';

describe('fixJsonItems', () => {
  it('旧 enum 被迁移：snacks_sweets → snacks_drinks', () => {
    const json = JSON.stringify({
      merchant: 'X',
      total: 100,
      items: [{ name: 'チョコ', category: 'snacks_sweets', lineTotal: 100 }],
    });
    const res = fixJsonItems(json);
    expect(res).not.toBeNull();
    expect(res!.changed).toBe(1);
    const parsed = JSON.parse(res!.json);
    expect(parsed.items[0].category).toBe('snacks_drinks');
    // 不动金额/名称/total
    expect(parsed.items[0].lineTotal).toBe(100);
    expect(parsed.items[0].name).toBe('チョコ');
    expect(parsed.total).toBe(100);
  });

  it('缺失分类按商品名补：豆腐 → food_ingredients', () => {
    const json = JSON.stringify({ items: [{ name: '豆腐', lineTotal: 50 }] });
    const res = fixJsonItems(json);
    expect(res).not.toBeNull();
    expect(JSON.parse(res!.json).items[0].category).toBe('food_ingredients');
  });

  it('店铺类型词分类被纠正：非超市 + チキンカツサンド → ready_to_eat', () => {
    const json = JSON.stringify({
      items: [{ name: 'チキンカツサンド', category: '非超市', lineTotal: 300 }],
    });
    const res = fixJsonItems(json);
    expect(res).not.toBeNull();
    expect(JSON.parse(res!.json).items[0].category).toBe('ready_to_eat');
  });

  it('已是合法新 enum → 无变化（幂等）', () => {
    const json = JSON.stringify({ items: [{ name: '豆腐', category: 'food_ingredients' }] });
    expect(fixJsonItems(json)).toBeNull();
  });

  it('数组形态也支持', () => {
    const json = JSON.stringify([{ name: 'ティッシュ', category: 'daily_goods' }]);
    const res = fixJsonItems(json);
    expect(res).not.toBeNull();
    expect(JSON.parse(res!.json)[0].category).toBe('household');
  });

  it('非法 JSON / 空 → null', () => {
    expect(fixJsonItems('not json')).toBeNull();
    expect(fixJsonItems(null)).toBeNull();
    expect(fixJsonItems('')).toBeNull();
  });
});


describe('fixJsonItems user override protection (M1-A)', () => {
  it('user layer does not reclassify explicit other via item name', () => {
    const json = JSON.stringify({
      items: [{ name: '豆腐', category: 'other', classification_source: 'user', lineTotal: 50 }],
    });
    expect(fixJsonItems(json, { layer: 'user' })).toBeNull();
  });

  it('analysis layer preserves classification_source=user', () => {
    const json = JSON.stringify({
      items: [{ name: '豆腐', category: 'other', classification_source: 'user', lineTotal: 50 }],
    });
    expect(fixJsonItems(json, { layer: 'analysis' })).toBeNull();
  });
});
