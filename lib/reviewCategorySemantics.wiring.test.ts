import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HISTORY_HELPER = 'materializeHistoryEditedItemCategorySemantics';
const SCAN_REVIEW_HELPER = 'materializeScanReviewItemCategorySemantics';

function readPage(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8');
}

function sourceRegion(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`missing source region ${startMarker} .. ${endMarker}`);
  }
  return source.slice(start, end);
}

/** Drop line comments and block comments. Not a JavaScript parser. */
function stripComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i);
      i = newline < 0 ? source.length : newline;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    out += source[i];
  }
  return out;
}

/** A call is `name(` after comments are removed. An import or bare identifier does not match. */
function invocationCount(region: string, helperName: string): number {
  const code = stripComments(region);
  return [...code.matchAll(new RegExp(`\\b${helperName}\\s*\\(`, 'g'))].length;
}

const HISTORY_CATEGORY_LEARNING_CALLS = [
  'learnFromUserEdit',
  'upsertProductDictionary',
  'upsertProductNameAlias',
] as const;

function skipQuoted(code: string, start: number): number {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i += 1) {
    if (code[i] === '\\') {
      i += 1;
      continue;
    }
    if (code[i] === quote) return i;
  }
  return code.length;
}

/**
 * Body of `if (prepared.categoryChangedThisEdit) { ... }` after comments are
 * removed. Nested braces count. The walk stops at the matching close, not the
 * first `}`.
 */
function categoryChangedThisEditBlock(source: string): { body: string; outside: string } {
  const code = stripComments(source);
  const match = /if\s*\(\s*prepared\.categoryChangedThisEdit\s*\)/.exec(code);
  if (!match || match.index == null) {
    throw new Error('missing categoryChangedThisEdit condition');
  }
  let i = match.index + match[0].length;
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1;
  if (code[i] !== '{') {
    throw new Error('categoryChangedThisEdit condition has no brace block');
  }
  const open = i;
  let depth = 0;
  for (; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(code, i);
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          body: code.slice(open + 1, i),
          outside: code.slice(0, match.index) + code.slice(i + 1),
        };
      }
    }
  }
  throw new Error('unclosed categoryChangedThisEdit block');
}

function learningCallsAreExclusiveToCategoryChange(source: string): boolean {
  const { body, outside } = categoryChangedThisEditBlock(source);
  return HISTORY_CATEGORY_LEARNING_CALLS.every(
    (name) => invocationCount(body, name) === 1 && invocationCount(outside, name) === 0
  );
}

describe('review category semantics page wiring', () => {
  it('history item save calls the history materializer', () => {
    const source = readPage('../app/(tabs)/history/[id].tsx');
    const savePath = sourceRegion(
      source,
      'const onSaveItemEdit = async () => {',
      'const onDelete = async () => {'
    );

    expect(savePath).not.toMatch(/^\s*import\s/m);
    expect(invocationCount(savePath, 'prepareHistoryItemEdit')).toBe(1);
    const helper = readPage('./historyItemEdit.ts');
    expect(invocationCount(helper, HISTORY_HELPER)).toBe(1);
    expect(invocationCount(helper.replace(/\s*\(/g, ''), HISTORY_HELPER)).toBe(0);
    expect(invocationCount(savePath, 'stampUserClassificationProvenance')).toBe(0);
  });

  it('history category learning stays inside categoryChangedThisEdit', () => {
    const source = readPage('../app/(tabs)/history/[id].tsx');
    const savePath = sourceRegion(
      source,
      'const onSaveItemEdit = async () => {',
      'const onDelete = async () => {'
    );
    const { body, outside } = categoryChangedThisEditBlock(savePath);

    for (const name of HISTORY_CATEGORY_LEARNING_CALLS) {
      expect(invocationCount(body, name)).toBe(1);
      expect(invocationCount(outside, name)).toBe(0);
    }
    expect(learningCallsAreExclusiveToCategoryChange(savePath)).toBe(true);
  });

  it('rejects category learning that sits outside the condition', () => {
    const emptyBlock = [
      'if (prepared.categoryChangedThisEdit) {}',
      'await learnFromUserEdit(...);',
      'await upsertProductDictionary(...);',
      'await upsertProductNameAlias(...);',
    ].join('\n');
    expect(learningCallsAreExclusiveToCategoryChange(emptyBlock)).toBe(false);
    expect(invocationCount(categoryChangedThisEditBlock(emptyBlock).body, 'learnFromUserEdit')).toBe(
      0
    );

    const partialBlock = [
      'if (prepared.categoryChangedThisEdit) {',
      '  await learnFromUserEdit(...);',
      '}',
      'await upsertProductDictionary(...);',
      'await upsertProductNameAlias(...);',
    ].join('\n');
    expect(learningCallsAreExclusiveToCategoryChange(partialBlock)).toBe(false);

    const nested = [
      'if   (  prepared.categoryChangedThisEdit  )',
      '{',
      '  // learnFromUserEdit(',
      '  await learnFromUserEdit(',
      '    name,',
      '    category',
      '  );',
      '  await upsertProductDictionary({',
      '    nested: { ok: true },',
      '  });',
      '  await upsertProductNameAlias({',
      "    source: 'manual',",
      '    inner: { kept: true },',
      '  });',
      '}',
      'const stored = await listAllReceiptsForCurrentOwnerPurchaseTruth();',
    ].join('\n');
    expect(learningCallsAreExclusiveToCategoryChange(nested)).toBe(true);
  });

  it('scan review finalItemsForSave calls the scan-review materializer', () => {
    const source = readPage('../app/scan-review/[draftId].tsx');
    const materialization = sourceRegion(
      source,
      'const finalItemsForSave = useMemo(() => {',
      'const duplicateGateAnalysis = useMemo(() => {'
    );

    expect(materialization).not.toMatch(/^\s*import\s/m);
    expect(invocationCount(materialization, SCAN_REVIEW_HELPER)).toBe(1);
    expect(invocationCount(materialization.replace(/\s*\(/g, ''), SCAN_REVIEW_HELPER)).toBe(0);
  });

  it('counts a real call and ignores commented or imported names', () => {
    const helper = HISTORY_HELPER;
    const realCall = `const onSaveItemEdit = async () => {\n  nextItem = ${helper}(nextItem, {});\n};\n`;
    expect(invocationCount(realCall, helper)).toBe(1);

    const commented = [
      `const onSaveItemEdit = async () => {`,
      `  // ${helper}(`,
      `  /* ${SCAN_REVIEW_HELPER}( */`,
      `};`,
    ].join('\n');
    expect(invocationCount(commented, helper)).toBe(0);
    expect(invocationCount(commented, SCAN_REVIEW_HELPER)).toBe(0);

    const withImportOutside = [
      `import { ${helper} } from '@/lib/reviewCategorySemantics';`,
      `const onSaveItemEdit = async () => {`,
      `  // ${helper}(`,
      `  nextItem = nextItem;`,
      `};`,
      `const onDelete = async () => {`,
    ].join('\n');
    const savePath = sourceRegion(
      withImportOutside,
      'const onSaveItemEdit = async () => {',
      'const onDelete = async () => {'
    );
    expect(savePath).toContain(helper);
    expect(invocationCount(savePath, helper)).toBe(0);
  });
});
