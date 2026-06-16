/**
 * 新小票落库后的增长分析回填（原在首页内联，审核保存后复用）。
 */

import { getReceipt, listReceipts, updateReceipt } from './db';
import { shouldTriggerByCount, shouldTriggerByPeriod, getAnalysisLevel } from './analysisTriggers';
import {
  buildAggregateAnalysisV1,
  buildWeeklyReportV1,
  buildMonthlyReportV1,
} from './growthAnalysisEngineV1';

export async function runPostSaveGrowthAnalysis(savedReceiptId: string): Promise<void> {
  const all = await listReceipts();
  const receiptCount = all.length;
  const level = getAnalysisLevel(receiptCount);

  const shouldCount = shouldTriggerByCount(receiptCount) && (receiptCount === 3 || receiptCount === 5);
  const shouldWeekly = shouldTriggerByPeriod('weekly');
  const shouldMonthly = shouldTriggerByPeriod('monthly');

  if (!shouldCount && !shouldWeekly && !shouldMonthly) return;

  const row = await getReceipt(savedReceiptId);
  if (!row) return;

  let analysisObj: any;
  try {
    analysisObj = JSON.parse(row.analysis_json || '{}');
  } catch {
    analysisObj = {};
  }
  const nextOutputs = { ...(analysisObj.analysis_outputs_v1 || {}) } as any;
  if (shouldCount) {
    nextOutputs.aggregate_level = buildAggregateAnalysisV1(all);
    if (__DEV__) console.log('[GrowthAnalysis] aggregate_level', nextOutputs.aggregate_level);
  }
  if (shouldWeekly) {
    nextOutputs.weekly = buildWeeklyReportV1(all);
    if (__DEV__) console.log('[GrowthAnalysis] weekly', { total_spend: nextOutputs.weekly.total_spend });
  }
  if (shouldMonthly) {
    nextOutputs.monthly = buildMonthlyReportV1(all);
    if (__DEV__) console.log('[GrowthAnalysis] monthly', { total_spend: nextOutputs.monthly.total_spend });
  }

  try {
    const { buildGrowthTemplateL2, buildGrowthTemplateL3 } = await import('./analysisTemplatesV1');
    const templates = { ...(nextOutputs.templates_v1 || {}) } as any;
    if (shouldCount && receiptCount === 3 && nextOutputs.aggregate_level) {
      templates.growth_template = buildGrowthTemplateL2({
        aggregate: nextOutputs.aggregate_level,
        weekly: nextOutputs.weekly,
      });
    }
    if (shouldCount && receiptCount === 5 && nextOutputs.aggregate_level) {
      templates.growth_template = buildGrowthTemplateL3({
        aggregate: nextOutputs.aggregate_level,
        weekly: nextOutputs.weekly,
        monthly: nextOutputs.monthly,
      });
    }
    nextOutputs.templates_v1 = templates;
    if (__DEV__ && templates.growth_template) {
      console.log('[GrowthAnalysis] template', templates.growth_template);
    }
  } catch (e) {
    if (__DEV__) console.warn('[GrowthAnalysis] template build failed:', e);
  }

  analysisObj.analysis_outputs_v1 = nextOutputs;
  analysisObj.analysis_level = level;
  await updateReceipt({ id: row.id, analysis: analysisObj });
}
