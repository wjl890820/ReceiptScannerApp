/**
 * 历史列表查询参数构建（纯逻辑，不依赖 DB）。
 * 供 listReceiptsForList 使用，可单独单测。
 */
export type ListReceiptsQueryOptions = {
  limit?: number;
  offset?: number;
  sortBy?: 'date' | 'total';
  /** 历史查询关键词：当前用于 merchant_raw/merchant_normalized/note 的 LIKE */
  searchQuery?: string;
};

export function listReceiptsForListParams(
  options?: ListReceiptsQueryOptions | number
): { orderBy: string; limit: number; offset: number; whereClause: string; whereParams: unknown[] } {
  const opts: ListReceiptsQueryOptions =
    typeof options === 'number' ? { limit: options } : options ?? {};
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const offset = Math.max(0, opts.offset ?? 0);
  const sortBy = opts.sortBy === 'total' ? 'total' : 'date';
  const orderBy =
    sortBy === 'total'
      ? 'total DESC, COALESCE(transaction_at, created_at) DESC'
      : 'COALESCE(transaction_at, created_at) DESC';

  const rawQuery = (opts.searchQuery ?? '').trim();
  const hasSearch = rawQuery.length > 0;
  const whereClause = hasSearch
    ? 'WHERE (merchant_raw LIKE ? OR merchant_normalized LIKE ? OR note LIKE ?)'
    : '';
  const like = hasSearch ? `%${rawQuery}%` : '';
  const whereParams = hasSearch ? [like, like, like] : [];

  return { orderBy, limit, offset, whereClause, whereParams };
}
