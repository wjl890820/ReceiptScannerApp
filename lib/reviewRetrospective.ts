/**
 * 审核闭环复盘：基于 receipts（recognition_snapshot_json + analysis_json.review_meta）
 * 与学习表（product_name_alias manual、product_dictionary manual）聚合统计。
 */

import {
  listReceiptsForReviewStats,
  listManualProductNameAliases,
  countManualProductDictionaryEntries,
  type ReceiptReviewStatsRow,
} from './db';
import { getCurrentLocale } from './i18n';
import { normalizeReceiptItemName, normalizeMerchantName } from './productNormalizer';
import { RECEIPT_REVIEW_ERROR_TAGS, isReceiptReviewErrorTag } from './reviewErrorTags';

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function numEq(a: unknown, b: unknown): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return trimStr(a) === trimStr(b);
  return Math.abs(x - y) < 0.0005;
}

export type LineDiff = {
  index: number;
  snapName: string;
  finName: string;
  snapCat: string;
  finCat: string;
  nameChanged: boolean;
  categoryChanged: boolean;
  qtyOrLineChanged: boolean;
};

export type ReceiptPairDiff = {
  id: string;
  tagList: string[];
  hasMerchantDiff: boolean;
  hasTransactionDateDiff: boolean;
  hasTotalDiff: boolean;
  hasTaxDiff: boolean;
  hasItemNameDiff: boolean;
  hasCategoryDiff: boolean;
  hasItemQtyOrLineDiff: boolean;
  hasItemCountMismatch: boolean;
  lineDiffs: LineDiff[];
  hasStructuralDiff: boolean;
  fullyUnchanged: boolean;
  corrected: boolean;
  categoryOnlyReceipt: boolean;
  headerNumericOrDateOnlyReceipt: boolean;
};

export function diffReceiptSnapshotVsFinal(row: ReceiptReviewStatsRow): ReceiptPairDiff | null {
  let fin: any;
  let snap: any;
  try {
    fin = JSON.parse(row.analysis_json || '{}');
  } catch {
    return null;
  }
  try {
    snap = JSON.parse(row.recognition_snapshot_json || '{}');
  } catch {
    return null;
  }

  const rawTags = fin?.review_meta?.error_tags;
  const tagList = Array.isArray(rawTags)
    ? rawTags.filter((x: unknown) => typeof x === 'string' && isReceiptReviewErrorTag(x))
    : [];

  const hasMerchantDiff = trimStr(snap?.merchant) !== trimStr(fin?.merchant);
  const hasTransactionDateDiff = trimStr(snap?.transactionDate) !== trimStr(fin?.transactionDate);
  const hasTotalDiff = !numEq(snap?.total, fin?.total);
  const hasTaxDiff = !numEq(snap?.tax, fin?.tax);

  const sItems = Array.isArray(snap?.items) ? snap.items : [];
  const fItems = Array.isArray(fin?.items) ? fin.items : [];
  const hasItemCountMismatch = sItems.length !== fItems.length;

  const lineDiffs: LineDiff[] = [];
  let hasItemNameDiff = false;
  let hasCategoryDiff = false;
  let hasItemQtyOrLineDiff = false;

  const n = Math.min(sItems.length, fItems.length);
  for (let i = 0; i < n; i++) {
    const si = sItems[i] || {};
    const fi = fItems[i] || {};
    const snapName = trimStr(si.name);
    const finName = trimStr(fi.name);
    const snapCat = trimStr(si.category);
    const finCat = trimStr(fi.category);
    const sq = Number(si.quantity ?? 1);
    const fq = Number(fi.quantity ?? 1);
    const sLt = Number(si.lineTotal ?? si.line_total ?? 0);
    const fLt = Number(fi.lineTotal ?? fi.line_total ?? 0);
    const nameChanged = snapName !== finName;
    const categoryChanged = snapCat !== finCat;
    const qtyOrLineChanged = sq !== fq || !numEq(sLt, fLt);
    if (nameChanged) hasItemNameDiff = true;
    if (categoryChanged) hasCategoryDiff = true;
    if (qtyOrLineChanged) hasItemQtyOrLineDiff = true;
    lineDiffs.push({
      index: i,
      snapName,
      finName,
      snapCat,
      finCat,
      nameChanged,
      categoryChanged,
      qtyOrLineChanged,
    });
  }

  if (hasItemCountMismatch) {
    hasItemNameDiff = true;
  }

  const hasStructuralDiff =
    hasMerchantDiff ||
    hasTransactionDateDiff ||
    hasTotalDiff ||
    hasTaxDiff ||
    hasItemNameDiff ||
    hasCategoryDiff ||
    hasItemQtyOrLineDiff ||
    hasItemCountMismatch;

  const fullyUnchanged = tagList.length === 0 && !hasStructuralDiff;
  const corrected = tagList.length > 0 || hasStructuralDiff;

  const categoryOnlyReceipt =
    hasCategoryDiff &&
    !hasItemNameDiff &&
    !hasMerchantDiff &&
    !hasTransactionDateDiff &&
    !hasTotalDiff &&
    !hasTaxDiff &&
    !hasItemQtyOrLineDiff &&
    !hasItemCountMismatch;

  const headerNumericOrDateOnlyReceipt =
    (hasTotalDiff || hasTaxDiff || hasTransactionDateDiff) &&
    !hasMerchantDiff &&
    !hasItemNameDiff &&
    !hasCategoryDiff &&
    !hasItemQtyOrLineDiff &&
    !hasItemCountMismatch;

  return {
    id: row.id,
    tagList,
    hasMerchantDiff,
    hasTransactionDateDiff,
    hasTotalDiff,
    hasTaxDiff,
    hasItemNameDiff,
    hasCategoryDiff,
    hasItemQtyOrLineDiff,
    hasItemCountMismatch,
    lineDiffs,
    hasStructuralDiff,
    fullyUnchanged,
    corrected,
    categoryOnlyReceipt,
    headerNumericOrDateOnlyReceipt,
  };
}

function buildManualAliasMatchSet(
  rows: { alias_normalized: string; canonical_name: string; merchant_hint: string }[]
): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    const a = (r.alias_normalized || '').trim().toLowerCase();
    const c = (r.canonical_name || '').trim().toLowerCase();
    const mh = (r.merchant_hint || '').trim();
    if (!a || !c) continue;
    set.add(`${a}\t${c}\t`);
    if (mh) set.add(`${a}\t${c}\t${mh}`);
  }
  return set;
}

export function nameCorrectionMatchesManualAlias(
  matchSet: Set<string>,
  origNorm: string,
  finalName: string,
  merchantRaw: string | null
): boolean {
  const c = finalName.trim().toLowerCase();
  const a = origNorm.trim().toLowerCase();
  if (!a || !c) return false;
  const mh = merchantRaw ? normalizeMerchantName(merchantRaw) : '';
  if (matchSet.has(`${a}\t${c}\t${mh}`)) return true;
  if (matchSet.has(`${a}\t${c}\t`)) return true;
  return false;
}

export type ReviewRetrospectiveReport = {
  generatedAt: number;
  receiptSampleLimit: number;
  totals: {
    reviewedReceiptCount: number;
    correctedReceiptCount: number;
    fullyUnchangedReceiptCount: number;
  };
  errorTagCounts: Record<string, number>;
  buckets: {
    receiptsWithItemNameDiff: number;
    receiptsWithCategoryOnlyDiff: number;
    receiptsWithHeaderNumericOrDateOnly: number;
    receiptsTaggedOcrOrParse: number;
  };
  topOriginalNamesEdited: { originalDisplayName: string; events: number }[];
  topAliasCanonicalFromReceipts: {
    aliasNormalized: string;
    canonicalName: string;
    occurrences: number;
    matchedManualAliasRow: boolean;
  }[];
  topCategoryTransitions: { from: string; to: string; count: number }[];
  topCategoryFixByFinalItemName: { itemName: string; count: number }[];
  learning: {
    nameCorrectionEvents: number;
    nameCorrectionEventsMatchedManualAlias: number;
    manualAliasRowCount: number;
    manualDictionaryEntryCount: number;
  };
  legend: string[];
};

function buildLegendLines(): string[] {
  const loc = getCurrentLocale();
  if (loc === 'en') {
    return [
      'Reviewed receipts: rows with recognition_snapshot_json (review pipeline).',
      'Corrected: non-empty error_tags OR any structural diff vs snapshot.',
      'Fully unchanged: no error_tags and no structural diff.',
      '"Category-only" receipts: only line category changed; names/header/qty/line totals/row count match snapshot.',
      '"Header/date/tax only": only total, tax, or transactionDate changed; no item name/category/qty/line amount changes.',
      'Top edited names: counts by snapshot line item display string.',
      'alias→canonical: normalized original → final name occurrences on receipts; matchedManualAliasRow checks manual alias table.',
      'Name corrections vs learning: matched / events ratio uses per-event match with merchant hint or empty hint.',
      'manual product_dictionary row count is informational only (no per-line reconciliation).',
    ];
  }
  if (loc === 'ja') {
    return [
      '総レビュー枚数：recognition_snapshot_json があるレシート（レビュー経路）。',
      '修正あり：error_tags がある、またはスナップショットと構造差分がある。',
      '差分なし：タグなしかつ構造差分なし。',
      '「分類のみ」：行の分類のみ変化。商品名・ヘッダ・数量・行金額・行数は一致。',
      '「合計/税/日付のみ」：total / tax / transactionDate のみ変化。商品名・分類・行数量/金額の変化なし。',
      '改名が多い名前：スナップショット行の表示名で集計。',
      'alias→canonical：正規化した元名→確定名の出現回数。manual 別名表との一致を別途表示。',
      '学習表との照合：イベントごとに manual alias へ一致した割合（merchant hint または空 hint）。',
      'manual product_dictionary 行数は参考値（行ごとの自動突合はしない）。',
    ];
  }
  return [
    '总审核张数：存在 recognition_snapshot_json 的小票（审核闭环落库）。',
    '已修正张数：review_meta.error_tags 非空，或与快照有任何结构化字段差异。',
    '完全无误张数：无 error_tags 且无结构化差异。',
    '「仅分类」张：仅行分类变化，商品名/抬头/数量/行金额/行数与快照一致。',
    '「仅 total/date/tax」张：仅合计、税或 transactionDate 变化，无商品名/分类/行级数量金额变化。',
    '「识别名修改最多」：按快照行商品名字符串聚合改名次数。',
    '「alias→canonical」：按规范化原名→人工最终名在小票中的出现次数；matched 表示与 manual 别名表一致。',
    '名称修正与学习表：matched/events 为已进入 product_name_alias(manual) 的占比（按事件计）。',
    'product_dictionary manual 行数仅作参考，不与逐行自动对账。',
  ];
}

export async function buildReviewRetrospectiveReport(limit = 2000): Promise<ReviewRetrospectiveReport> {
  const rows = await listReceiptsForReviewStats(limit);
  const manualAliases = await listManualProductNameAliases();
  const matchSet = buildManualAliasMatchSet(manualAliases);
  const dictManualCount = await countManualProductDictionaryEntries();

  const errorTagCounts: Record<string, number> = {};
  for (const tg of RECEIPT_REVIEW_ERROR_TAGS) errorTagCounts[tg] = 0;

  let correctedReceiptCount = 0;
  let fullyUnchangedReceiptCount = 0;
  let receiptsWithItemNameDiff = 0;
  let receiptsWithCategoryOnlyDiff = 0;
  let receiptsWithHeaderNumericOrDateOnly = 0;
  let receiptsTaggedOcrOrParse = 0;

  const origNameEvents = new Map<string, number>();
  const aliasCanonFromReceipts = new Map<string, { aliasNormalized: string; canonicalName: string; n: number }>();
  const catTrans = new Map<string, { from: string; to: string; n: number }>();
  const catFixByName = new Map<string, number>();

  let nameCorrectionEvents = 0;
  let nameCorrectionEventsMatchedManualAlias = 0;

  for (const row of rows) {
    const d = diffReceiptSnapshotVsFinal(row);
    if (!d) continue;
    if (d.corrected) correctedReceiptCount++;
    if (d.fullyUnchanged) fullyUnchangedReceiptCount++;

    if (d.hasItemNameDiff) receiptsWithItemNameDiff++;
    if (d.categoryOnlyReceipt) receiptsWithCategoryOnlyDiff++;
    if (d.headerNumericOrDateOnlyReceipt) receiptsWithHeaderNumericOrDateOnly++;

    if (d.tagList.some((x) => x === 'OCR_ERROR' || x === 'PARSE_ERROR')) {
      receiptsTaggedOcrOrParse++;
    }
    for (const tg of d.tagList) {
      if (errorTagCounts[tg] !== undefined) errorTagCounts[tg]++;
      else errorTagCounts[tg] = (errorTagCounts[tg] ?? 0) + 1;
    }

    let finMerchant: string | null = null;
    try {
      finMerchant = trimStr(JSON.parse(row.analysis_json || '{}')?.merchant) || null;
    } catch {
      finMerchant = null;
    }

    for (const line of d.lineDiffs) {
      if (line.nameChanged && line.snapName) {
        origNameEvents.set(line.snapName, (origNameEvents.get(line.snapName) ?? 0) + 1);
        const origNorm = normalizeReceiptItemName(line.snapName).normalized_name;
        const canon = line.finName.trim();
        if (origNorm && canon) {
          nameCorrectionEvents++;
          if (nameCorrectionMatchesManualAlias(matchSet, origNorm, canon, finMerchant)) {
            nameCorrectionEventsMatchedManualAlias++;
          }
          const key = `${origNorm}=>${canon}`;
          const cur = aliasCanonFromReceipts.get(key);
          if (cur) cur.n += 1;
          else aliasCanonFromReceipts.set(key, { aliasNormalized: origNorm, canonicalName: canon, n: 1 });
        }
      }
      if (line.categoryChanged && line.snapCat !== line.finCat) {
        const tk = `${line.snapCat}=>${line.finCat}`;
        const c = catTrans.get(tk);
        if (c) c.n += 1;
        else catTrans.set(tk, { from: line.snapCat || '(空)', to: line.finCat || '(空)', n: 1 });
        const nm = line.finName || line.snapName;
        if (nm) catFixByName.set(nm, (catFixByName.get(nm) ?? 0) + 1);
      }
    }
  }

  const topOriginalNamesEdited = Array.from(origNameEvents.entries())
    .map(([originalDisplayName, events]) => ({ originalDisplayName, events }))
    .sort((a, b) => b.events - a.events)
    .slice(0, 30);

  const topAliasCanonicalFromReceipts = Array.from(aliasCanonFromReceipts.values())
    .map((v) => ({
      aliasNormalized: v.aliasNormalized,
      canonicalName: v.canonicalName,
      occurrences: v.n,
      matchedManualAliasRow: manualAliases.some(
        (r) =>
          r.alias_normalized === v.aliasNormalized &&
          r.canonical_name.trim().toLowerCase() === v.canonicalName.trim().toLowerCase()
      ),
    }))
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 30);

  const topCategoryTransitions = Array.from(catTrans.values())
    .map((v) => ({ from: v.from, to: v.to, count: v.n }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const topCategoryFixByFinalItemName = Array.from(catFixByName.entries())
    .map(([itemName, count]) => ({ itemName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  const legend = buildLegendLines();

  return {
    generatedAt: Date.now(),
    receiptSampleLimit: limit,
    totals: {
      reviewedReceiptCount: rows.length,
      correctedReceiptCount,
      fullyUnchangedReceiptCount,
    },
    errorTagCounts,
    buckets: {
      receiptsWithItemNameDiff,
      receiptsWithCategoryOnlyDiff,
      receiptsWithHeaderNumericOrDateOnly,
      receiptsTaggedOcrOrParse,
    },
    topOriginalNamesEdited,
    topAliasCanonicalFromReceipts,
    topCategoryTransitions,
    topCategoryFixByFinalItemName,
    learning: {
      nameCorrectionEvents,
      nameCorrectionEventsMatchedManualAlias,
      manualAliasRowCount: manualAliases.length,
      manualDictionaryEntryCount: dictManualCount,
    },
    legend,
  };
}

export function reportToJson(report: ReviewRetrospectiveReport): string {
  return JSON.stringify(report, null, 2);
}
