/**
 * H3-A prompt-contract tests for OCR merchant extraction.
 * These assert the production prompt text. They do not call Gemini and
 * cannot prove the model will obey the prompt at runtime.
 */
import * as fs from 'fs';
import * as path from 'path';

const EDGE_OCR_PATH = path.resolve(
  __dirname,
  '../supabase/functions/ocr-receipt/handler.ts'
);

function readBuildOcrPromptSource(): string {
  const source = fs.readFileSync(EDGE_OCR_PATH, 'utf8');
  const start = source.indexOf('function buildOcrPrompt()');
  const end = source.indexOf('function buildDateVerifyPrompt()');
  if (start < 0 || end <= start) {
    throw new Error('buildOcrPrompt bounds missing');
  }
  return source.slice(start, end);
}

describe('H3-A OCR merchant branch prompt contract (not Gemini runtime proof)', () => {
  const prompt = readBuildOcrPromptSource();

  it('asks for the most specific printed merchant and preserves a full branch', () => {
    expect(prompt).toContain('最も具体的な店名');
    expect(prompt).toContain('印刷された店名全文を残す');
    expect(prompt).toContain('全文の店名をチェーン名だけに短くしない');
    expect(prompt).toContain('この規則はすべての店に適用する');
    expect(prompt).toContain('○○スーパー古川南店');
    expect(prompt).toContain('merchant="○○スーパー古川南店"');
  });

  it('returns chain only when that is all the printed evidence supports', () => {
    expect(prompt).toContain('○○スーパー');
    expect(prompt).toContain('merchant="○○スーパー"');
    expect(prompt).toContain('印刷証拠がチェーン名だけならチェーン名だけを返す');
    expect(prompt).toContain('存在しない支店を作らない');
    expect(prompt).toContain('読めない支店を補うより、支店を省く方が正しい');
  });

  it('forbids inventing a branch from layout, address, assortment, or examples', () => {
    expect(prompt).toContain('レシート版式');
    expect(prompt).toContain('住所だけ');
    expect(prompt).toContain('商品構成');
    expect(prompt).toContain('支払手段');
    expect(prompt).toContain('チェーン知識');
    expect(prompt).toContain('過去のレシート');
    expect(prompt).toContain('モデルの一般知識');
    expect(prompt).toContain('プロンプト内の例からは推測しない');
    expect(prompt).toContain('読めない場合は null');
    expect(prompt).toContain('推測で埋めない');
  });

  it('normalizes only the 7-Eleven brand segment and keeps a printed branch', () => {
    expect(prompt).toContain('表記ゆれの正規化はブランド部分だけ');
    expect(prompt).toContain('印刷された支店・地域の接尾を残す');
    expect(prompt).toContain('7-Eleven / セブンイレブン / セブンーイレブン');
    expect(prompt).toContain('セブンイレブン仙台中央店');
    expect(prompt).toContain('merchant="セブン-イレブン仙台中央店"');
    expect(prompt).toContain('支店が印刷されているとき "セブン-イレブン" だけに短くしてはならない');
  });

  it('does not teach chain-only output or an Aeon-only exception', () => {
    expect(prompt).not.toContain('店名（例: セブン-イレブン）');
    expect(prompt).not.toContain('イオンは店名を短くしない');
    expect(prompt).not.toMatch(/if\s+Lawson|if\s+York|if\s+Gyomu/i);
    expect(prompt).not.toContain('ローソン大崎');
    expect(prompt).not.toContain('ヨークベニマル');
    expect(prompt).not.toContain('業務スーパー');
  });

  it('does not replace an unreadable merchant with a guessed name', () => {
    const source = fs.readFileSync(EDGE_OCR_PATH, 'utf8');
    expect(source).toContain(
      "merchant: typeof parsed.merchant === 'string' ? parsed.merchant : undefined,"
    );
  });

  it('covers O9 semantics with generic examples, not merchant-specific rules', () => {
    // 090–094 / 092: printed chain + branch must stay the full printed name.
    expect(prompt).toContain('印刷が「○○スーパー古川南店」→ merchant="○○スーパー古川南店"');
    // Chain-only evidence must not grow a branch. 095/096-style full output stays valid
    // because the same clause keeps an already-full printed name.
    expect(prompt).toContain('印刷が「○○スーパー」→ merchant="○○スーパー"');
  });
});
