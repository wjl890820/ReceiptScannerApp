import { getReceiptItems } from './receiptItems';

describe('getReceiptItems', () => {
  const analysisItems = [{ name: '牛乳', lineTotal: 200, category: 'food_ingredients' }];
  const userItems = [{ name: '編集後', lineTotal: 300, category: 'snacks_drinks' }];

  it('只有 analysis_json.items 时使用 analysis items', () => {
    expect(
      getReceiptItems({
        analysis_json: JSON.stringify({ items: analysisItems }),
        user_items_json: null,
      })
    ).toEqual(analysisItems);
  });

  it('有合法 user_items_json 时优先使用 user_items_json', () => {
    expect(
      getReceiptItems({
        analysis_json: JSON.stringify({ items: analysisItems }),
        user_items_json: JSON.stringify(userItems),
      })
    ).toEqual(userItems);
  });

  it('user_items_json 损坏时 fallback 到 analysis_json.items', () => {
    expect(
      getReceiptItems({
        analysis_json: JSON.stringify({ items: analysisItems }),
        user_items_json: '{not-json',
      })
    ).toEqual(analysisItems);
  });

  it('两者都坏时返回 []', () => {
    expect(
      getReceiptItems({
        analysis_json: 'bad',
        user_items_json: 'also-bad',
      })
    ).toEqual([]);
  });

  it('user_items_json 非 array 时 fallback analysis_json', () => {
    expect(
      getReceiptItems({
        analysis_json: JSON.stringify({ items: analysisItems }),
        user_items_json: JSON.stringify({ foo: 1 }),
      })
    ).toEqual(analysisItems);
  });
});

describe('getReceiptItems: stats 口径', () => {
  it('历史编辑后 stats 应读到 user_items_json 分类', () => {
    const items = getReceiptItems({
      analysis_json: JSON.stringify({
        items: [{ name: 'A', lineTotal: 100, category: 'food_ingredients' }],
      }),
      user_items_json: JSON.stringify([
        { name: 'A', lineTotal: 100, category: 'snacks_drinks' },
      ]),
    });
    expect((items[0] as any).category).toBe('snacks_drinks');
  });
});
