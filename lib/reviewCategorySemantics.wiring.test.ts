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

describe('review category semantics page wiring', () => {
  it('history item save calls the history materializer', () => {
    const source = readPage('../app/(tabs)/history/[id].tsx');
    const savePath = sourceRegion(
      source,
      'const onSaveItemEdit = async () => {',
      'const onDelete = async () => {'
    );

    expect(savePath).not.toMatch(/^\s*import\s/m);
    expect(invocationCount(savePath, HISTORY_HELPER)).toBe(1);
    expect(invocationCount(savePath.replace(/\s*\(/g, ''), HISTORY_HELPER)).toBe(0);
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
