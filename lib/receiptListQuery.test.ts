/**
 * 最小单测：历史列表查询参数构建（纯逻辑，不连 DB）。
 */
import { listReceiptsForListParams } from './receiptListQuery';

describe('listReceiptsForListParams', () => {
  it('defaults to date desc, limit 200, offset 0', () => {
    const got = listReceiptsForListParams(undefined);
    expect(got.orderBy).toBe('COALESCE(transaction_at, created_at) DESC');
    expect(got.limit).toBe(200);
    expect(got.offset).toBe(0);
  });

  it('accepts number as limit (backward compat)', () => {
    const got = listReceiptsForListParams(50);
    expect(got.limit).toBe(50);
    expect(got.offset).toBe(0);
    expect(got.orderBy).toContain('transaction_at');
  });

  it('sortBy total uses total DESC', () => {
    const got = listReceiptsForListParams({ sortBy: 'total', limit: 100 });
    expect(got.orderBy).toBe('total DESC, COALESCE(transaction_at, created_at) DESC');
    expect(got.limit).toBe(100);
  });

  it('sortBy date uses date desc', () => {
    const got = listReceiptsForListParams({ sortBy: 'date', limit: 10 });
    expect(got.orderBy).toBe('COALESCE(transaction_at, created_at) DESC');
  });

  it('applies offset', () => {
    const got = listReceiptsForListParams({ limit: 20, offset: 40 });
    expect(got.limit).toBe(20);
    expect(got.offset).toBe(40);
  });

  it('clamps limit to 1..500', () => {
    expect(listReceiptsForListParams({ limit: 0 }).limit).toBe(1);
    expect(listReceiptsForListParams({ limit: 1000 }).limit).toBe(500);
    expect(listReceiptsForListParams({ limit: -1 }).limit).toBe(1);
  });

  it('clamps offset to >= 0', () => {
    expect(listReceiptsForListParams({ offset: -5 }).offset).toBe(0);
  });

  it('builds where clause when searchQuery is provided', () => {
    const got = listReceiptsForListParams({ searchQuery: 'milk' });
    expect(got.whereClause).toContain('WHERE');
    expect(got.whereParams).toEqual(['%milk%', '%milk%', '%milk%']);
  });

  it('omits where clause when searchQuery is empty', () => {
    const got = listReceiptsForListParams({ searchQuery: '  ' });
    expect(got.whereClause).toBe('');
    expect(got.whereParams).toEqual([]);
  });
});
