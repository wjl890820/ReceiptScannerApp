/**
 * 最小测试：彩蛋触发入口 tryShowNextEasterEgg。
 * 通过 mock easterEggs 聚焦“何时返回 shown:true / shown:false”与“不重复触发已展示里程碑”。
 */
import type { ReceiptRow } from './db';
import { tryShowNextEasterEgg } from './homeEasterEggHelpers';

const mockHasShownMilestone = jest.fn();
const mockMarkMilestoneShown = jest.fn();
const mockGenerateEasterEggContent = jest.fn();

jest.mock('./easterEggs', () => ({
  shouldTriggerMilestone: (count: number, m: number) => count >= m,
  hasShownMilestone: (...args: unknown[]) => mockHasShownMilestone(...args),
  markMilestoneShown: (...args: unknown[]) => mockMarkMilestoneShown(...args),
  generateEasterEggContent: (...args: unknown[]) => mockGenerateEasterEggContent(...args),
}));

function minimalReceiptRow(id: string): ReceiptRow {
  return {
    id,
    created_at: Date.now(),
    transaction_at: Date.now(),
    image_uri: '',
    total: 0,
    tax: 0,
    currency: 'JPY',
    analysis_json: '{}',
    merchant_raw: null,
    merchant_normalized: null,
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

const sampleContent = { title: 'Test', bullets: ['a'], cta: 'ok' };

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateEasterEggContent.mockReturnValue(sampleContent);
});

describe('tryShowNextEasterEgg', () => {
  it('returns shown:false when receipt count below first milestone (3)', async () => {
    const receipts = [minimalReceiptRow('1'), minimalReceiptRow('2')];
    const result = await tryShowNextEasterEgg(2, receipts, 'en');
    expect(result).toEqual({ shown: false });
    expect(mockHasShownMilestone).not.toHaveBeenCalled();
    expect(mockMarkMilestoneShown).not.toHaveBeenCalled();
  });

  it('returns shown:true and triggers milestone 3 when count >= 3 and 3 not yet shown', async () => {
    mockHasShownMilestone.mockResolvedValue(false);
    const receipts = Array.from({ length: 3 }, (_, i) => minimalReceiptRow(String(i + 1)));
    const result = await tryShowNextEasterEgg(3, receipts, 'en');
    expect(result).toEqual({ shown: true, content: sampleContent, milestone: 3 });
    expect(mockHasShownMilestone).toHaveBeenCalledWith(3);
    expect(mockGenerateEasterEggContent).toHaveBeenCalledWith(3, receipts, 'en');
    expect(mockMarkMilestoneShown).toHaveBeenCalledWith(3);
  });

  it('does not trigger same milestone twice when already shown', async () => {
    mockHasShownMilestone.mockImplementation((m: number) => Promise.resolve(m === 3));
    const receipts = Array.from({ length: 5 }, (_, i) => minimalReceiptRow(String(i + 1)));
    const result = await tryShowNextEasterEgg(5, receipts, 'zh');
    expect(result).toEqual({ shown: true, content: sampleContent, milestone: 5 });
    expect(mockHasShownMilestone).toHaveBeenCalledWith(3);
    expect(mockHasShownMilestone).toHaveBeenCalledWith(5);
    expect(mockMarkMilestoneShown).toHaveBeenCalledWith(5);
    expect(mockMarkMilestoneShown).not.toHaveBeenCalledWith(3);
  });

  it('returns shown:false when all triggered milestones already shown', async () => {
    mockHasShownMilestone.mockResolvedValue(true);
    const receipts = Array.from({ length: 10 }, (_, i) => minimalReceiptRow(String(i + 1)));
    const result = await tryShowNextEasterEgg(10, receipts, 'ja');
    expect(result).toEqual({ shown: false });
    expect(mockHasShownMilestone).toHaveBeenCalledWith(3);
    expect(mockHasShownMilestone).toHaveBeenCalledWith(5);
    expect(mockHasShownMilestone).toHaveBeenCalledWith(7);
    expect(mockHasShownMilestone).toHaveBeenCalledWith(10);
    expect(mockMarkMilestoneShown).not.toHaveBeenCalled();
    expect(mockGenerateEasterEggContent).not.toHaveBeenCalled();
  });
});
