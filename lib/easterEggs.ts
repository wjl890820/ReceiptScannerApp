// lib/easterEggs.ts
import * as SQLite from 'expo-sqlite';
import type { ReceiptRow } from './db';
import { normalizeMerchantName } from './productNormalizer';

export type Milestone = 3 | 5 | 7 | 10;

export type EasterEggContent = {
  title: string;
  bullets: string[];
  cta?: string;
};

let _db: SQLite.SQLiteDatabase | null = null;
let _tableInited = false;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!_db) {
    _db = await SQLite.openDatabaseAsync('receipts_v2.db');
  }
  return _db;
}

/**
 * 初始化 easter_eggs_shown 表（幂等）
 */
async function initTableIfNeeded(): Promise<void> {
  if (_tableInited) return;
  
  const db = await getDb();
  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS easter_eggs_shown (
        milestone INTEGER PRIMARY KEY NOT NULL,
        shown_at INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_easter_eggs_shown_shown_at
        ON easter_eggs_shown(shown_at DESC);
    `);
    _tableInited = true;
  } catch (e) {
    if (__DEV__) {
      console.warn('[EasterEggs] Failed to init table:', e);
    }
    // 即使失败也标记为已尝试，避免无限重试
    _tableInited = true;
  }
}

/**
 * 检查里程碑是否已显示
 */
export async function hasShownMilestone(milestone: Milestone): Promise<boolean> {
  try {
    await initTableIfNeeded();
    const db = await getDb();
    const row = await db.getFirstAsync<{ milestone: number }>(
      `SELECT milestone FROM easter_eggs_shown WHERE milestone = ?`,
      [milestone]
    );
    return !!row;
  } catch (e: any) {
    // 如果表不存在，尝试创建后重试
    if (e?.message?.includes('no such table')) {
      _tableInited = false; // 重置标志，允许重试
      try {
        await initTableIfNeeded();
        const db = await getDb();
        const row = await db.getFirstAsync<{ milestone: number }>(
          `SELECT milestone FROM easter_eggs_shown WHERE milestone = ?`,
          [milestone]
        );
        return !!row;
      } catch (retryError) {
        if (__DEV__) {
          console.warn('[EasterEggs] Failed to query after retry:', retryError);
        }
        return false; // 失败时返回 false，允许显示彩蛋
      }
    }
    if (__DEV__) {
      console.warn('[EasterEggs] Failed to check milestone:', e);
    }
    return false; // 失败时返回 false，允许显示彩蛋
  }
}

/**
 * 标记里程碑已显示
 */
export async function markMilestoneShown(milestone: Milestone): Promise<void> {
  try {
    await initTableIfNeeded();
    const db = await getDb();
    const now = Date.now();
    await db.runAsync(
      `INSERT OR REPLACE INTO easter_eggs_shown (milestone, shown_at) VALUES (?, ?)`,
      [milestone, now]
    );
  } catch (e: any) {
    // 如果表不存在，尝试创建后重试
    if (e?.message?.includes('no such table')) {
      _tableInited = false; // 重置标志，允许重试
      try {
        await initTableIfNeeded();
        const db = await getDb();
        const now = Date.now();
        await db.runAsync(
          `INSERT OR REPLACE INTO easter_eggs_shown (milestone, shown_at) VALUES (?, ?)`,
          [milestone, now]
        );
      } catch (retryError) {
        if (__DEV__) {
          console.warn('[EasterEggs] Failed to mark milestone after retry:', retryError);
        }
        // 静默失败，不影响主流程
      }
    } else {
      if (__DEV__) {
        console.warn('[EasterEggs] Failed to mark milestone:', e);
      }
      // 静默失败，不影响主流程
    }
  }
}

/**
 * 检查是否应该触发里程碑（基于收据数量）
 */
export function shouldTriggerMilestone(receiptCount: number, milestone: Milestone): boolean {
  return receiptCount >= milestone;
}

/**
 * 生成里程碑内容（基于收据数据）
 */
export function generateEasterEggContent(
  milestone: Milestone,
  receipts: ReceiptRow[],
  locale: 'en' | 'zh' | 'ja' = 'en'
): EasterEggContent {
  if (milestone === 3) {
    return generateMilestone3(receipts, locale);
  } else if (milestone === 5) {
    return generateMilestone5(receipts, locale);
  } else if (milestone === 7) {
    return generateMilestone7(receipts, locale);
  } else if (milestone === 10) {
    return generateMilestone10(receipts, locale);
  }

  return { title: '', bullets: [] };
}

function generateMilestone3(receipts: ReceiptRow[], locale: 'en' | 'zh' | 'ja'): EasterEggContent {
  const total = receipts.reduce((sum, r) => sum + (r.total || 0), 0);
  const avg = receipts.length > 0 ? Math.round(total / receipts.length) : 0;

  if (locale === 'zh') {
    return {
      title: '初次印象',
      bullets: [
        `已扫描 ${receipts.length} 张收据`,
        `平均每张 ¥${avg.toLocaleString()}`,
        '继续扫描以发现更多模式',
      ],
      cta: '继续扫描解锁更多洞察',
    };
  } else if (locale === 'ja') {
    return {
      title: '初めての印象',
      bullets: [
        `${receipts.length} 枚のレシートをスキャン`,
        `平均 ¥${avg.toLocaleString()}`,
        'スキャンを続けてパターンを発見',
      ],
      cta: 'スキャンを続けてインサイトを解除',
    };
  } else {
    return {
      title: 'First Impression',
      bullets: [
        `Scanned ${receipts.length} receipts`,
        `Average ¥${avg.toLocaleString()} per receipt`,
        'Keep scanning to discover patterns',
      ],
      cta: 'Keep scanning to unlock insights',
    };
  }
}

function generateMilestone5(receipts: ReceiptRow[], locale: 'en' | 'zh' | 'ja'): EasterEggContent {
  // 统计最常去的商家和最常见的分类
  const merchantMap = new Map<string, number>();
  const categoryMap = new Map<string, number>();

  for (const receipt of receipts) {
    const merchantKey = normalizeMerchantName(
      receipt.merchant_normalized || receipt.merchant_raw || ''
    );
    if (merchantKey) {
      merchantMap.set(merchantKey, (merchantMap.get(merchantKey) || 0) + 1);
    }

    try {
      const analysis = JSON.parse(receipt.analysis_json || '{}');
      const items = analysis.items || [];
      for (const item of items) {
        const category = item.category || 'Other';
        categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
      }
    } catch (e) {
      // ignore
    }
  }

  const topMerchant = Array.from(merchantMap.entries())
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Various';
  const topCategory = Array.from(categoryMap.entries())
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Various';

  // 提取常见关键词
  const keywords = new Set<string>();
  for (const receipt of receipts) {
    try {
      const analysis = JSON.parse(receipt.analysis_json || '{}');
      const items = analysis.items || [];
      for (const item of items) {
        const name = String(item?.name || '').toLowerCase();
        const words = name.split(/[\s・、,，]/).filter((w) => w.length > 1 && w.length < 10);
        words.slice(0, 2).forEach((w) => keywords.add(w));
      }
    } catch (e) {
      // ignore
    }
  }

  const commonKeywords = Array.from(keywords).slice(0, 3).join(', ');

  if (locale === 'zh') {
    return {
      title: '消费模式',
      bullets: [
        `最常去：${topMerchant}`,
        `主要类别：${topCategory}`,
        commonKeywords ? `常见商品：${commonKeywords}` : '继续扫描发现更多',
      ],
      cta: '扫描更多解锁价格雷达',
    };
  } else if (locale === 'ja') {
    return {
      title: '消費パターン',
      bullets: [
        `よく行く店：${topMerchant}`,
        `主要カテゴリ：${topCategory}`,
        commonKeywords ? `よく買う商品：${commonKeywords}` : 'スキャンを続けて発見',
      ],
      cta: 'スキャンを続けて価格レーダーを解除',
    };
  } else {
    return {
      title: 'Spending Patterns',
      bullets: [
        `Most frequent: ${topMerchant}`,
        `Top category: ${topCategory}`,
        commonKeywords ? `Common items: ${commonKeywords}` : 'Keep scanning to discover',
      ],
      cta: 'Scan more to unlock Price Radar',
    };
  }
}

function generateMilestone7(receipts: ReceiptRow[], locale: 'en' | 'zh' | 'ja'): EasterEggContent {
  // 计算增长最快的分类
  const categoryGrowth: Array<{ category: string; growth: number }> = [];
  const categoryMap = new Map<string, number[]>();

  // 按时间排序
  const sortedReceipts = [...receipts].sort((a, b) => a.created_at - b.created_at);
  const midPoint = Math.floor(sortedReceipts.length / 2);
  const firstHalf = sortedReceipts.slice(0, midPoint);
  const secondHalf = sortedReceipts.slice(midPoint);

  // 统计前后半段的分类
  const countCategory = (receipts: ReceiptRow[], map: Map<string, number>) => {
    for (const receipt of receipts) {
      try {
        const analysis = JSON.parse(receipt.analysis_json || '{}');
        const items = analysis.items || [];
        for (const item of items) {
          const category = item.category || 'Other';
          map.set(category, (map.get(category) || 0) + 1);
        }
      } catch (e) {
        // ignore
      }
    }
  };

  const firstHalfMap = new Map<string, number>();
  const secondHalfMap = new Map<string, number>();
  countCategory(firstHalf, firstHalfMap);
  countCategory(secondHalf, secondHalfMap);

  // 计算增长
  for (const [category, secondCount] of secondHalfMap.entries()) {
    const firstCount = firstHalfMap.get(category) || 0;
    if (firstCount > 0) {
      const growth = ((secondCount - firstCount) / firstCount) * 100;
      categoryGrowth.push({ category, growth });
    }
  }

  categoryGrowth.sort((a, b) => b.growth - a.growth);
  const fastestGrowing = categoryGrowth[0]?.category || 'Various';

  // 查找重复购买链（同一商家连续出现）
  let repeatedChain = 0;
  for (let i = 1; i < sortedReceipts.length; i++) {
    const prevMerchant = normalizeMerchantName(
      sortedReceipts[i - 1].merchant_normalized || sortedReceipts[i - 1].merchant_raw || ''
    );
    const currMerchant = normalizeMerchantName(
      sortedReceipts[i].merchant_normalized || sortedReceipts[i].merchant_raw || ''
    );
    if (prevMerchant && currMerchant && prevMerchant === currMerchant) {
      repeatedChain++;
    }
  }

  if (locale === 'zh') {
    return {
      title: '趋势与解锁',
      bullets: [
        `增长最快：${fastestGrowing}`,
        repeatedChain > 0 ? `重复购买链：${repeatedChain} 次` : '发现新的购买习惯',
        '价格雷达已解锁！',
      ],
      cta: '查看分析页面',
    };
  } else if (locale === 'ja') {
    return {
      title: 'トレンドと解除',
      bullets: [
        `最も成長：${fastestGrowing}`,
        repeatedChain > 0 ? `繰り返し購入：${repeatedChain} 回` : '新しい購入習慣を発見',
        '価格レーダーが解除されました！',
      ],
      cta: '分析ページを確認',
    };
  } else {
    return {
      title: 'Trends & Unlocks',
      bullets: [
        `Fastest growing: ${fastestGrowing}`,
        repeatedChain > 0 ? `Repeated purchases: ${repeatedChain} times` : 'New buying habits discovered',
        'Price Radar unlocked!',
      ],
      cta: 'View Analysis Page',
    };
  }
}

function generateMilestone10(receipts: ReceiptRow[], locale: 'en' | 'zh' | 'ja'): EasterEggContent {
  const total = receipts.reduce((sum, r) => sum + (r.total || 0), 0);
  const avg = receipts.length > 0 ? Math.round(total / receipts.length) : 0;

  if (locale === 'zh') {
    return {
      title: '里程碑达成',
      bullets: [
        `已扫描 ${receipts.length} 张收据`,
        `总支出 ¥${total.toLocaleString()}`,
        '继续探索更多洞察',
      ],
      cta: '查看完整分析',
    };
  } else if (locale === 'ja') {
    return {
      title: 'マイルストーン達成',
      bullets: [
        `${receipts.length} 枚のレシートをスキャン`,
        `総支出 ¥${total.toLocaleString()}`,
        'より多くのインサイトを探索',
      ],
      cta: '完全な分析を表示',
    };
  } else {
    return {
      title: 'Milestone Achieved',
      bullets: [
        `Scanned ${receipts.length} receipts`,
        `Total spend ¥${total.toLocaleString()}`,
        'Explore more insights',
      ],
      cta: 'View Full Analysis',
    };
  }
}
