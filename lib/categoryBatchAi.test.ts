/**
 * 批量 AI 文本分类 fallback 单测（不触发真实网络，使用依赖注入的 classify）。
 * 覆盖：本地结果优先、单次请求、阈值应用/建议、旧分类拒绝、超时不崩、待确认数减少。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

// 避免加载 expo-constants / react-native（Node 测试环境无法解析 ESM 原生模块）。
// 给定合法的 Supabase 配置，使 classifyItemsBatch 能进入 fetch（fetch 本身被 mock）。
jest.mock('./env', () => ({
  getSupabaseUrl: () => 'https://example.supabase.co',
  getSupabaseAnonKey: () => 'eyJhbGciOi.fake.payload',
  isJwtLike: () => true,
  getCategoryBatchAiTimeoutMs: () => 9000,
  getCategoryBatchAiMaxItems: () => 40,
}));
jest.mock('./deviceId', () => ({ getDeviceId: async () => 'test-device' }));
jest.mock('./i18n', () => ({ getCurrentLocale: () => 'ja' }));

import {
  sanitizeAiCategory,
  decideFromAi,
  selectUncategorizedItems,
  applyBatchAiResults,
  runBatchAiFallback,
  classifyItemsBatch,
  BATCH_AI_APPLY_THRESHOLD,
  BATCH_AI_SUGGEST_THRESHOLD,
  type BatchAiInputItem,
  type BatchAiResultItem,
} from './categoryBatchAi';

function item(overrides: Record<string, any>): any {
  return {
    name: 'x',
    normalized_name: 'x',
    category: 'uncategorized',
    classification_status: 'fallback',
    classification_confidence: 0,
    ...overrides,
  };
}

function countUncategorized(items: any[]): number {
  return items.filter((it) => it.category === 'uncategorized').length;
}

function fakeResponse(
  status: number,
  jsonBody: any,
  opts: { jsonThrows?: boolean } = {}
): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (opts.jsonThrows) throw new Error('invalid json');
      return jsonBody;
    },
    text: async () => {
      try {
        return JSON.stringify(jsonBody ?? {});
      } catch {
        return '';
      }
    },
  };
}

const ORIGINAL_FETCH = (global as any).fetch;
afterEach(() => {
  (global as any).fetch = ORIGINAL_FETCH;
  jest.restoreAllMocks();
});

describe('sanitizeAiCategory: 仅接受 V1 ACTIVE，拒绝 legacy / 旧分类', () => {
  it('接受新核心分类与 other', () => {
    expect(sanitizeAiCategory('snacks_drinks')).toBe('snacks_drinks');
    expect(sanitizeAiCategory('food_ingredients')).toBe('food_ingredients');
    expect(sanitizeAiCategory('other')).toBe('other');
  });
  it('uncategorized 无效；personal_care/pet_care 为活跃 V1 spending', () => {
    expect(sanitizeAiCategory('uncategorized')).toBeNull();
    expect(sanitizeAiCategory('personal_care')).toBe('personal_care');
    expect(sanitizeAiCategory('pet_care')).toBe('pet_care');
  });
  it('拒绝旧分类名 → null', () => {
    for (const old of ['meat_seafood', 'snacks_sweets', 'prepared_food', 'beverages', 'snacks', 'ingredients', 'produce']) {
      expect(sanitizeAiCategory(old)).toBeNull();
    }
  });
  it('空/非字符串 → null', () => {
    expect(sanitizeAiCategory('')).toBeNull();
    expect(sanitizeAiCategory(null)).toBeNull();
    expect(sanitizeAiCategory(123 as any)).toBeNull();
  });
});

describe('decideFromAi: 置信度阈值', () => {
  it('>=0.75 apply', () => {
    expect(decideFromAi('snacks_drinks', 0.75)).toEqual({ action: 'apply', category: 'snacks_drinks', confidence: 0.75 });
    expect(decideFromAi('other', 0.9)).toEqual({ action: 'apply', category: 'other', confidence: 0.9 });
  });
  it('0.5–0.75 suggest', () => {
    expect(decideFromAi('snacks_drinks', 0.5)).toEqual({ action: 'suggest', category: 'snacks_drinks', confidence: 0.5 });
    expect(decideFromAi('snacks_drinks', 0.74)).toEqual({ action: 'suggest', category: 'snacks_drinks', confidence: 0.74 });
  });
  it('<0.5 keep', () => {
    expect(decideFromAi('snacks_drinks', 0.49)).toEqual({ action: 'keep' });
    expect(decideFromAi('snacks_drinks', 0)).toEqual({ action: 'keep' });
  });
  it('旧分类即使高置信度也 keep', () => {
    expect(decideFromAi('meat_seafood', 0.99)).toEqual({ action: 'keep' });
  });
  it('阈值常量符合规格', () => {
    expect(BATCH_AI_APPLY_THRESHOLD).toBe(0.75);
    expect(BATCH_AI_SUGGEST_THRESHOLD).toBe(0.5);
  });
});

describe('selectUncategorizedItems: 仅选 uncategorized', () => {
  it('本地已识别商品不会进入 batch AI', () => {
    const items = [
      item({ name: '豆腐', category: 'food_ingredients' }),
      item({ name: '???', category: 'uncategorized' }),
      item({ name: 'ボス', category: 'snacks_drinks' }),
      item({ name: '???2', category: 'uncategorized' }),
    ];
    const selected = selectUncategorizedItems(items);
    expect(selected.map((s) => s.index)).toEqual([1, 3]);
    expect(selected.every((s) => items[s.index].category === 'uncategorized')).toBe(true);
  });

  it('跳过完全无名的 uncategorized', () => {
    const items = [item({ name: '', normalized_name: '', category: 'uncategorized' })];
    expect(selectUncategorizedItems(items)).toHaveLength(0);
  });
});

describe('applyBatchAiResults: 应用/建议/保护本地结果', () => {
  it('高置信度结果被应用为最终分类', () => {
    const items = [item({ name: '???', category: 'uncategorized' })];
    const res: BatchAiResultItem[] = [{ index: 0, category: 'snacks_drinks', confidence: 0.9 }];
    const { appliedCount, suggestedCount } = applyBatchAiResults(items, res);
    expect(appliedCount).toBe(1);
    expect(suggestedCount).toBe(0);
    expect(items[0].category).toBe('snacks_drinks');
    expect(items[0].classification_source).toBe('ai_batch');
    expect(items[0].classification_status).toBe('ok');
  });

  it('低置信度保持 uncategorized，但记录 suggestedCategory', () => {
    const items = [item({ name: '???', category: 'uncategorized' })];
    const res: BatchAiResultItem[] = [{ index: 0, category: 'ready_to_eat', confidence: 0.6 }];
    const { appliedCount, suggestedCount } = applyBatchAiResults(items, res, { now: () => 12345 });
    expect(appliedCount).toBe(0);
    expect(suggestedCount).toBe(1);
    expect(items[0].category).toBe('uncategorized');
    expect(items[0].suggestedCategory).toBe('ready_to_eat');
    expect(items[0].suggestedConfidence).toBe(0.6);
    expect(items[0].suggestedAt).toBe(12345);
  });

  it('confidence<0.5 完全保持 uncategorized，无建议', () => {
    const items = [item({ name: '???', category: 'uncategorized' })];
    applyBatchAiResults(items, [{ index: 0, category: 'snacks_drinks', confidence: 0.3 }]);
    expect(items[0].category).toBe('uncategorized');
    expect(items[0].suggestedCategory).toBeUndefined();
  });

  it('AI 返回旧分类（高置信度）→ 拒绝，保持 uncategorized', () => {
    const items = [item({ name: '肉', category: 'uncategorized' })];
    const { appliedCount } = applyBatchAiResults(items, [{ index: 0, category: 'meat_seafood', confidence: 0.95 }]);
    expect(appliedCount).toBe(0);
    expect(items[0].category).toBe('uncategorized');
  });

  it('用户学习/本地规则结果（非 uncategorized）不会被 AI 覆盖', () => {
    const items = [
      item({ name: '豆腐', category: 'food_ingredients', classification_source: 'mapping', classification_status: 'ok' }),
      item({ name: 'ラーメン', category: 'ready_to_eat', classification_source: 'rules', classification_status: 'ok' }),
    ];
    // AI 试图把这两个改成别的分类
    const res: BatchAiResultItem[] = [
      { index: 0, category: 'snacks_drinks', confidence: 0.99 },
      { index: 1, category: 'snacks_drinks', confidence: 0.99 },
    ];
    const { appliedCount } = applyBatchAiResults(items, res);
    expect(appliedCount).toBe(0);
    expect(items[0].category).toBe('food_ingredients');
    expect(items[0].classification_source).toBe('mapping');
    expect(items[1].category).toBe('ready_to_eat');
    expect(items[1].classification_source).toBe('rules');
  });
});

describe('runBatchAiFallback: 编排 + 单次请求 + 容错', () => {
  it('无 uncategorized → 不发请求', async () => {
    const items = [item({ category: 'food_ingredients' }), item({ category: 'snacks_drinks' })];
    const classify = jest.fn();
    const r = await runBatchAiFallback(items, {}, { classify });
    expect(r.called).toBe(false);
    expect(classify).not.toHaveBeenCalled();
  });

  it('多个 uncategorized 只触发一次 batch，且只发送 uncategorized', async () => {
    const items = [
      item({ name: '豆腐', category: 'food_ingredients' }),
      item({ name: 'A', category: 'uncategorized' }),
      item({ name: 'B', category: 'uncategorized' }),
      item({ name: 'C', category: 'uncategorized' }),
    ];
    const classify = jest.fn(async (sent: BatchAiInputItem[]) =>
      sent.map((s) => ({ index: s.index, category: 'snacks_drinks', confidence: 0.9 }))
    );
    const r = await runBatchAiFallback(items, {}, { classify });
    expect(classify).toHaveBeenCalledTimes(1);
    const sentArg = classify.mock.calls[0][0] as BatchAiInputItem[];
    expect(sentArg.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(r.appliedCount).toBe(3);
  });

  it('AI timeout（classify 返回 null）→ 不抛错，保持 uncategorized', async () => {
    const items = [item({ name: 'A', category: 'uncategorized' })];
    const classify = jest.fn(async () => null);
    const r = await runBatchAiFallback(items, {}, { classify });
    expect(r.called).toBe(true);
    expect(r.appliedCount).toBe(0);
    expect(items[0].category).toBe('uncategorized');
  });

  it('classify 抛错也被吞掉，保持 uncategorized', async () => {
    const items = [item({ name: 'A', category: 'uncategorized' })];
    const classify = jest.fn(async () => {
      throw new Error('boom');
    });
    const r = await runBatchAiFallback(items, {}, { classify });
    expect(r.appliedCount).toBe(0);
    expect(items[0].category).toBe('uncategorized');
  });

  it('Edge 真实失败（runBatchAiFallback + 真实 classifyItemsBatch + mock fetch success:false）→ no-op，保持 uncategorized', async () => {
    const items = [item({ name: 'A', category: 'uncategorized' })];
    (global as any).fetch = jest.fn(async () => fakeResponse(502, {
      success: false,
      error: { code: 'CLASSIFY_ITEMS_FAILED', message: 'Gemini call failed', requestId: 'r1' },
    }));
    const r = await runBatchAiFallback(items, {});
    expect(r.called).toBe(true);
    expect(r.appliedCount).toBe(0);
    expect(items[0].category).toBe('uncategorized');
  });

  it('batch 成功后“待确认”数量减少', async () => {
    const items = [
      item({ name: '豆腐', category: 'food_ingredients' }),
      item({ name: 'A', category: 'uncategorized' }),
      item({ name: 'B', category: 'uncategorized' }),
      item({ name: 'C', category: 'uncategorized' }),
    ];
    expect(countUncategorized(items)).toBe(3);
    const classify = jest.fn(async (sent: BatchAiInputItem[]) =>
      sent.map((s, i) => ({
        index: s.index,
        category: 'snacks_drinks',
        // 让其中一个低置信度，验证它仍计入“待确认”
        confidence: i === 0 ? 0.6 : 0.9,
      }))
    );
    await runBatchAiFallback(items, {}, { classify });
    // 两个高置信度被应用，一个 0.6 仍为 uncategorized
    expect(countUncategorized(items)).toBe(1);
  });
});

describe('classifyItemsBatch: 网络层失败语义（mock fetch）', () => {
  const input: BatchAiInputItem[] = [{ index: 0, rawName: 'A', normalizedName: 'A' }];

  it('正常 success:true results → 返回映射结果', async () => {
    (global as any).fetch = jest.fn(async () =>
      fakeResponse(200, {
        success: true,
        results: [{ index: 0, categoryId: 'snacks_drinks', confidence: 0.9, reason: 'ok' }],
      })
    );
    const out = await classifyItemsBatch(input, {});
    expect(out).toEqual([{ index: 0, category: 'snacks_drinks', confidence: 0.9, reason: 'ok' }]);
  });

  it('success:false（HTTP 200）→ no-op，返回 null，不抛错', async () => {
    (global as any).fetch = jest.fn(async () =>
      fakeResponse(200, {
        success: false,
        error: { code: 'CLASSIFY_ITEMS_FAILED', message: 'x', requestId: 'r' },
      })
    );
    await expect(classifyItemsBatch(input, {})).resolves.toBeNull();
  });

  it('HTTP 500 + JSON success:false → no-op，返回 null', async () => {
    (global as any).fetch = jest.fn(async () =>
      fakeResponse(500, {
        success: false,
        error: { code: 'CLASSIFY_ITEMS_FAILED', message: 'internal', requestId: 'r' },
      })
    );
    await expect(classifyItemsBatch(input, {})).resolves.toBeNull();
  });

  it('Gemini 失败（502 success:false）→ 不红屏（不抛错），返回 null', async () => {
    (global as any).fetch = jest.fn(async () =>
      fakeResponse(502, {
        success: false,
        error: { code: 'CLASSIFY_ITEMS_FAILED', message: 'Gemini call failed', requestId: 'r' },
      })
    );
    await expect(classifyItemsBatch(input, {})).resolves.toBeNull();
  });

  it('timeout（fetch AbortError）→ 返回 null，不抛错', async () => {
    (global as any).fetch = jest.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(classifyItemsBatch(input, {})).resolves.toBeNull();
  });

  it('响应 JSON 解析失败 → 返回 null', async () => {
    (global as any).fetch = jest.fn(async () => fakeResponse(200, null, { jsonThrows: true }));
    await expect(classifyItemsBatch(input, {})).resolves.toBeNull();
  });
});
