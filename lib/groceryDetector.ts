// lib/groceryDetector.ts
// Detect if a receipt is from a grocery/supermarket store

/**
 * Normalize merchant name for matching
 * - Lowercase, trim
 * - Remove spaces and common punctuation
 * - Convert full-width to half-width where easy (at least remove "　" and unify "-")
 */
function normalizeMerchantName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  
  let normalized = name.trim().toLowerCase();
  
  // Remove full-width spaces
  normalized = normalized.replace(/　/g, '');
  // Remove regular spaces
  normalized = normalized.replace(/\s+/g, '');
  // Unify dashes/hyphens
  normalized = normalized.replace(/[－—–−]/g, '-');
  // Remove common punctuation
  normalized = normalized.replace(/[.,;:!?()[\]{}'"]/g, '');
  
  return normalized;
}

/**
 * Include list: Supermarket/grocery store keywords
 */
const INCLUDE_SUPERMARKETS = [
  // Major chains (English and Japanese)
  'aeon', 'イオン',
  'maxvalu', 'マックスバリュ',
  'daiei', 'ダイエー',
  'mybasket', 'マイバスケット',
  'life', 'ライフ',
  'seiyu', '西友',
  'ok', 'オーケー', 'okストア',
  'gyomu', '業務スーパー', '業務',
  'coop', 'コープ', 'seikyo', '生協',
  'maruetsu', 'マルエツ',
  'summit', 'サミット',
  'inageya', 'いなげや',
  'yorkbenimaru', 'ヨークベニマル',
  'belc', 'ベルク',
  'yaoko', 'ヤオコー',
  'kasumi', 'カスミ',
  'tokyustore', 'トウキョウストア',
  'hanamasa', 'ハナマサ',
  'donki', 'don quijote', 'ドンキホーテ',
  'costco', 'コストコ',
  'ropia', 'ロピア',
  'seijoishii', '成城石井',
  'apita', 'アピタ',
  'piago', 'ピアゴ',
  'uny', 'ユニー',
  'fresco', 'フレッシュ',
  // Generic grocery terms
  'スーパー', 'supermarket', 'スーパーマーケット',
  '食品館', '食料品', '食品',
  'grocery', 'groceries',
] as const;

/**
 * Exclude list: Non-grocery stores
 */
const EXCLUDE_NON_GROCERY = [
  // Convenience stores
  '7-eleven', 'セブンイレブン', 'セブン',
  'lawson', 'ローソン',
  'familymart', 'ファミリーマート', 'ファミマ',
  'ministop', 'ミニストップ',
  'newdays', 'ニューデイズ',
  // Drugstores
  'matsukiyo', 'マツキヨ', 'マツキヨココカラ',
  'sugi', 'スギ', 'スギ薬局',
  'tsuruha', 'ツルハ', 'ツルハドラッグ',
  'sundrug', 'サンドラッグ',
  'cocokara', 'ココカラ', 'ココカラファイン',
  'welcia', 'ウェルシア',
  // Restaurants/cafes (major chains)
  'mcdonalds', 'マクドナルド',
  'starbucks', 'スターバックス',
  'kfc', 'ケンタッキー',
  'mosburger', 'モスバーガー',
  'sukiya', 'すき家',
  'yoshinoya', '吉野家',
  'matsuya', '松屋',
  // E-commerce
  'amazon', 'アマゾン',
  'rakuten', '楽天',
  // Delivery
  'ubereats', 'ウーバーイーツ',
  'demae', '出前館',
] as const;

/**
 * Check if a merchant is a grocery/supermarket store
 * 
 * Rules:
 * 1. If merchant matches exclude list -> false
 * 2. Else if matches include list -> true
 * 3. Else if generic grocery words present -> true
 * 4. Else -> false
 */
export function isGroceryMerchant(
  merchantRaw?: string | null,
  merchantNormalized?: string | null
): boolean {
  // Use normalized if available, otherwise normalize raw
  const merchantName = merchantNormalized || merchantRaw;
  if (!merchantName) return false;

  const normalized = normalizeMerchantName(merchantName);

  // Rule 1: Check exclude list first
  for (const excludeTerm of EXCLUDE_NON_GROCERY) {
    if (normalized.includes(excludeTerm.toLowerCase())) {
      return false;
    }
  }

  // Rule 2: Check include list
  for (const includeTerm of INCLUDE_SUPERMARKETS) {
    if (normalized.includes(includeTerm.toLowerCase())) {
      return true;
    }
  }

  // Rule 3: Check generic grocery words
  const genericGroceryWords = ['スーパー', 'supermarket', '食品館', '食料品', 'grocery'];
  for (const word of genericGroceryWords) {
    if (normalized.includes(word.toLowerCase())) {
      return true;
    }
  }

  // Rule 4: Default to false
  return false;
}

/**
 * Conservative Costco detector for cropped-header receipts.
 * Requires multiple strong signals — never a single generic English word alone.
 */
export function detectCostcoReceiptSignals(input: {
  merchant?: string | null;
  items?: Array<{ name?: string | null }> | null;
  /** Optional OCR raw / full-receipt text (header fragments may only appear here). */
  rawText?: string | null;
}): { isCostco: boolean; score: number; reasons: string[] } {
  const merchant = String(input.merchant || '');
  const mNorm = normalizeMerchantName(merchant);
  const itemText = (input.items || [])
    .map((it) => String(it?.name || ''))
    .join('\n');
  const rawText = String(input.rawText || '');
  const evidenceBlob = `${merchant}\n${itemText}\n${rawText}`;
  const blobNorm = normalizeMerchantName(evidenceBlob);
  const reasons: string[] = [];
  let score = 0;

  if (/costco|コストコ/.test(mNorm) || /costco|コストコ/.test(blobNorm)) {
    return { isCostco: true, score: 10, reasons: ['explicit_costco_name'] };
  }

  // Header fragments may land in merchant, item rows, or raw OCR text — score each once.
  if (/biz\s*\/?\s*gold|bizgold/.test(merchant) || /biz\s*\/?\s*gold|bizgold/i.test(evidenceBlob)) {
    score += 1;
    reasons.push('biz_gold_signal');
  }
  if (/wholesale/i.test(merchant) || /wholesale/i.test(evidenceBlob)) {
    score += 1;
    reasons.push('wholesale_signal');
  }
  if (
    /御買上げ点数|お買上げ点数|お買上点数|会員番号|membership/i.test(evidenceBlob) ||
    /御買上げ点数|お買上げ点数|お買上点数/.test(merchant)
  ) {
    score += 1;
    reasons.push('costco_points_or_member_label');
  }
  // Costco JP line-item tax marks often end with E or T after the amount/name.
  const etHits = (input.items || []).filter((it) =>
    /\s[ET]$|[ET]\s*$/i.test(String(it?.name || '').trim())
  ).length;
  if (etHits >= 2) {
    score += 1;
    reasons.push('et_tax_suffix_items');
  }
  // Costco-style leading item codes (5–6 digits) on several lines
  const codeHits = (input.items || []).filter((it) =>
    /^\d{5,6}\b/.test(String(it?.name || '').trim())
  ).length;
  if (codeHits >= 3) {
    score += 1;
    reasons.push('item_code_layout');
  }

  return { isCostco: score >= 2, score, reasons };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use isGroceryMerchant instead
 */
export function isGroceryStore(merchantName: string | null | undefined): boolean {
  return isGroceryMerchant(merchantName, null);
}

/**
 * Get confidence level (0-1) for grocery detection
 */
export function getGroceryConfidence(
  merchantRaw?: string | null,
  merchantNormalized?: string | null
): number {
  return isGroceryMerchant(merchantRaw, merchantNormalized) ? 1.0 : 0.0;
}

/** 仅用于类型，避免 db 与 detector 循环依赖时用 */
type ReceiptRowLike = {
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  analysis_json?: string | null;
};

/**
 * 从收据列表中筛出「超市小票」，供分析页价格雷达、分类指数等使用。
 * 规则：isGroceryMerchant 为 true 或 analysis_json.is_grocery === true。
 */
export function filterGroceryReceipts<T extends ReceiptRowLike>(receipts: T[]): T[] {
  return receipts.filter((r) => {
    try {
      if (!r) return false;
      if (isGroceryMerchant(r.merchant_raw ?? null, r.merchant_normalized ?? null)) return true;
      try {
        const analysis = JSON.parse(r.analysis_json || '{}');
        return analysis.is_grocery === true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  });
}
