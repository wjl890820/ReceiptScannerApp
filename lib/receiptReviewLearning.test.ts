/**
 * 审核学习只在「用户手动改了分类/名称」时写入 item_category_mapping。
 * 普通保存（未改动）不得写入 category learning，避免错误分类自我强化。
 */

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('./receiptEnricher', () => ({ learnFromUserEdit: jest.fn(async () => {}) }));
jest.mock('./productDictionary', () => ({ upsertProductDictionary: jest.fn(async () => {}) }));
jest.mock('./productAlias', () => ({ upsertProductNameAlias: jest.fn(async () => {}) }));

import { applyReviewCorrectionsToLearning } from './receiptReviewLearning';
import { learnFromUserEdit } from './receiptEnricher';

const mockLearn = learnFromUserEdit as jest.Mock;

describe('applyReviewCorrectionsToLearning: 仅手动修改才学习', () => {
  beforeEach(() => mockLearn.mockClear());

  it('普通保存（名称与分类均未改动）→ 不写入 category learning', async () => {
    await applyReviewCorrectionsToLearning({
      snapshotItems: [{ name: 'シュガーバター', category: 'snacks_drinks' }],
      finalItems: [{ name: 'シュガーバター', category: 'snacks_drinks', review_source_index: 0 }],
      merchantRaw: 'セブン-イレブン',
    });
    expect(mockLearn).not.toHaveBeenCalled();
  });

  it('用户手动改分类（snacks_drinks → food_ingredients）→ 写入一次 learning', async () => {
    await applyReviewCorrectionsToLearning({
      snapshotItems: [{ name: 'シュガーバター', category: 'snacks_drinks' }],
      finalItems: [{ name: 'シュガーバター', category: 'food_ingredients', review_source_index: 0 }],
      merchantRaw: 'セブン-イレブン',
    });
    expect(mockLearn).toHaveBeenCalledTimes(1);
    expect(mockLearn).toHaveBeenCalledWith('シュガーバター', 'food_ingredients', 'セブン-イレブン');
  });

  it('用户手动改名称 → 也写入 learning', async () => {
    await applyReviewCorrectionsToLearning({
      snapshotItems: [{ name: 'シュガーバタ', category: 'snacks_drinks' }],
      finalItems: [{ name: 'シュガーバター', category: 'snacks_drinks', review_source_index: 0 }],
      merchantRaw: null,
    });
    expect(mockLearn).toHaveBeenCalledTimes(1);
  });
});
