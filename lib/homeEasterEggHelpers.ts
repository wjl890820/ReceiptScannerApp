/**
 * 首页彩蛋触发入口：在扫描完成后根据收据数量与已展示记录，决定是否展示下一个里程碑彩蛋。
 * 不包含 UI（Alert 由调用方负责），便于单测与复用。
 */
import type { ReceiptRow } from './db';
import {
  shouldTriggerMilestone,
  hasShownMilestone,
  markMilestoneShown,
  generateEasterEggContent,
  type Milestone,
  type EasterEggContent,
} from './easterEggs';

const MILESTONES: Milestone[] = [3, 5, 7, 10];

export type TryShowResult =
  | { shown: true; content: EasterEggContent; milestone: Milestone }
  | { shown: false };

/**
 * 检查当前收据数是否达到某个未展示过的里程碑，若达到则标记已展示并返回内容。
 * 调用方负责用 content 弹 Alert，本函数不包含 UI。
 */
export async function tryShowNextEasterEgg(
  receiptCount: number,
  allReceipts: ReceiptRow[],
  locale: 'en' | 'zh' | 'ja'
): Promise<TryShowResult> {
  for (const milestone of MILESTONES) {
    if (!shouldTriggerMilestone(receiptCount, milestone)) continue;
    const alreadyShown = await hasShownMilestone(milestone);
    if (alreadyShown) continue;

    const content = generateEasterEggContent(milestone, allReceipts, locale);
    await markMilestoneShown(milestone);
    return { shown: true, content, milestone };
  }
  return { shown: false };
}
