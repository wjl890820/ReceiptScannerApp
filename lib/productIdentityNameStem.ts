/**
 * Deterministic identity stem: strip structural quantity tokens so
 * 「1L」and「1000ML」can match when attributes are compatible.
 * Does NOT strip flavor/variant tokens (ZERO / レモン / 無糖 …).
 */

const STRUCTURAL_TOKEN_RE =
  /\d+(?:\.\d+)?\s*(?:ml|ｍｌ|l|ｌ|g|ｇ|kg|ｋｇ|cm|ｃｍ|m|ｍ|mm|ｍｍ|個|本|枚|袋|箱|缶|パック|ロール|玉|丁|束|杯|片)/gi;

const MULTIPACK_RE = /\d+(?:\.\d+)?\s*[×xX]\s*\d+\s*(?:本|個|袋|缶|パック)?/gi;

export function buildIdentityNameStem(text: string): string {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return '';
  let s = raw.normalize('NFKC').toLowerCase();
  s = s.replace(MULTIPACK_RE, ' ');
  s = s.replace(STRUCTURAL_TOKEN_RE, ' ');
  s = s.replace(/[・･\s]+/g, '');
  s = s.replace(/['"`´’“”]/g, '');
  return s.trim();
}
