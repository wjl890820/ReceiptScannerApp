// lib/analysisTriggers.ts

export type AnalysisLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type PeriodTrigger = 'weekly' | 'monthly';

export function getAnalysisLevel(receiptCount: number): AnalysisLevel {
  if (receiptCount <= 1) return 'L1';
  if (receiptCount <= 3) return 'L2';
  if (receiptCount <= 7) return 'L3';
  if (receiptCount <= 15) return 'L4';
  return 'L5';
}

export function shouldTriggerByCount(receiptCount: number): boolean {
  return [1, 3, 5, 10, 20].includes(receiptCount);
}

export function shouldTriggerByPeriod(period: PeriodTrigger, now: Date = new Date()): boolean {
  // Minimal hooks only; caller decides scheduling mechanism.
  if (period === 'weekly') {
    // Sunday boundary (0)
    return now.getDay() === 0;
  }
  // monthly: 1st day
  return now.getDate() === 1;
}

