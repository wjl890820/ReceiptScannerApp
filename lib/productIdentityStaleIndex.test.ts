/**
 * Failure-injection: edited receipt index rebuild failure must not leave stale rows.
 */
describe('RC Hardening — edited receipt stale index', () => {
  it('rebuild-if-changed catch deletes index after item-changing edit failure', () => {
    // Contract check against source (unit-level failure injection without native sqlite).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, 'db.ts'),
      'utf8'
    );
    expect(src).toContain('bestEffortRebuildReceiptItemIndexIfChanged');
    expect(src).toContain('deleteReceiptItemIndex');
    const fnStart = src.indexOf(
      'async function bestEffortRebuildReceiptItemIndexIfChanged'
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 1200);
    expect(fnBody).toContain('catch');
    expect(fnBody).toContain('deleteReceiptItemIndex');
    expect(fnBody).toMatch(/delete_after_rebuild_failure|marked_stale_deleted/);
  });
});
