import { useFocusEffect } from '@react-navigation/native';
import { useRouter, type Href } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { deleteReceipts, listReceiptsForList, type ReceiptListRow } from '@/lib/db';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import {
  buildHistoryReceiptRowA11yLabel,
  buildHistorySelectModeSubtitle,
  formatHistoryMerchantDisplay,
} from '@/lib/historyPresentation';
import { buildTopCategories, buildHistoryMetaLine } from '@/lib/receiptListHelpers';
import { formatDate } from '@/lib/formatDate';
import {
  normalizeReceiptItemSearchQuery,
  searchHistoryPurchases,
  type ReceiptItemSearchResult,
} from '@/lib/receiptItemSearch';
import {
  performHistoryPurchaseSearch,
  resolveHistorySearchSubmitAction,
  shouldApplyHistorySearchQueryChange,
} from '@/lib/historySearchUi';
import {
  buildProductSearchResultHref,
} from '@/lib/productDetailTarget';

/** Matches Home tab content clearance so rows clear the bottom tab bar. */
const TAB_BAR_CONTENT_CLEARANCE = 72;

type HistorySearchEntry =
  | { kind: 'item'; result: ReceiptItemSearchResult }
  | { kind: 'receipt'; result: ReceiptListRow };

export default function HistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<ReceiptListRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [itemResults, setItemResults] = useState<ReceiptItemSearchResult[]>([]);
  const [receiptResults, setReceiptResults] = useState<ReceiptListRow[]>([]);
  const searchQueryRef = useRef('');
  const searchRequestSequence = useRef(0);
  const lastCompletedNormalizedQueryRef = useRef('');

  const load = useCallback(async () => {
    try {
      const data = await listReceiptsForList({ limit: 200 });
      setRows(data);
    } catch (e: any) {
      console.error(e);
      Alert.alert(t('history.errors.loadTitle'), t('history.errors.loadMessage'));
    }
  }, []);

  const executeSearch = useCallback(async (query: string) => {
    const requestId = ++searchRequestSequence.current;
    const normalizedQuery = normalizeReceiptItemSearchQuery(query);
    if (!normalizedQuery) {
      lastCompletedNormalizedQueryRef.current = '';
      setSearching(false);
      setItemResults([]);
      setReceiptResults([]);
      return;
    }

    setSearching(true);
    try {
      const outcome = await performHistoryPurchaseSearch({
        rawQuery: query,
        isCurrent: () => requestId === searchRequestSequence.current,
        searchFn: searchHistoryPurchases,
      });

      if (outcome.status === 'stale') {
        return;
      }
      if (outcome.status === 'empty') {
        lastCompletedNormalizedQueryRef.current = '';
        setItemResults([]);
        setReceiptResults([]);
        return;
      }
      if (outcome.status === 'error') {
        console.error('[HistorySearch] search failed', outcome.error);
        lastCompletedNormalizedQueryRef.current = '';
        setItemResults([]);
        setReceiptResults([]);
        return;
      }

      lastCompletedNormalizedQueryRef.current = outcome.normalizedQuery;
      setItemResults(outcome.itemResults as ReceiptItemSearchResult[]);
      setReceiptResults(outcome.receiptResults as ReceiptListRow[]);
    } finally {
      if (requestId === searchRequestSequence.current) {
        setSearching(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void executeSearch(searchQuery);
    }, 220);
    return () => clearTimeout(timer);
  }, [executeSearch, searchQuery]);

  useFocusEffect(
    React.useCallback(() => {
      void load();
      const currentQuery = searchQueryRef.current;
      if (normalizeReceiptItemSearchQuery(currentQuery)) {
        void executeSearch(currentQuery);
      }
    }, [executeSearch, load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      load(),
      normalizeReceiptItemSearchQuery(searchQueryRef.current)
        ? executeSearch(searchQueryRef.current)
        : Promise.resolve(),
    ]);
    setRefreshing(false);
  }, [executeSearch, load]);

  const onSearchQueryChange = useCallback((value: string) => {
    // IME confirm / keyboard Search may re-fire the same text. Resetting
    // loading+results without a searchQuery change leaves a permanent spinner.
    if (!shouldApplyHistorySearchQueryChange(searchQueryRef.current, value)) {
      return;
    }

    searchRequestSequence.current += 1;
    searchQueryRef.current = value;
    lastCompletedNormalizedQueryRef.current = '';
    setSearchQuery(value);
    if (normalizeReceiptItemSearchQuery(value)) {
      setSelectMode(false);
      setSelectedIds(new Set());
      setSearching(true);
      setItemResults([]);
      setReceiptResults([]);
    } else {
      setSearching(false);
      setItemResults([]);
      setReceiptResults([]);
    }
  }, []);

  const onSubmitSearch = useCallback(() => {
    Keyboard.dismiss();
    const action = resolveHistorySearchSubmitAction({
      rawQuery: searchQueryRef.current,
      lastCompletedNormalizedQuery: lastCompletedNormalizedQueryRef.current,
    });

    if (action.type === 'clear') {
      searchRequestSequence.current += 1;
      lastCompletedNormalizedQueryRef.current = '';
      setSearching(false);
      setItemResults([]);
      setReceiptResults([]);
      return;
    }

    if (action.type === 'keep_results') {
      // Live search already finished for this query — keep rows, end spinner.
      setSearching(false);
      return;
    }

    void executeSearch(action.query);
  }, [executeSearch]);

  const clearSearch = useCallback(() => {
    searchQueryRef.current = '';
    searchRequestSequence.current += 1;
    lastCompletedNormalizedQueryRef.current = '';
    setSearchQuery('');
    setSearching(false);
    setItemResults([]);
    setReceiptResults([]);
  }, []);

  const toggleSelectMode = useCallback(() => {
    if (selectMode) {
      setSelectMode(false);
      setSelectedIds(new Set());
    } else {
      setSelectMode(true);
      setSelectedIds(new Set());
    }
  }, [selectMode]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const all = rows.every((r) => selectedIds.has(r.id));
    if (all) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.id)));
  }, [rows, selectedIds]);

  const onDeleteSelected = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    Alert.alert(
      t('history.batchDelete.confirmTitle'),
      t('history.batchDelete.confirmMessage', { n: ids.length }),
      [
        { text: t('history.batchDelete.confirmCancel'), style: 'cancel' },
        {
          text: t('history.batchDelete.confirmDelete'),
          style: 'destructive',
          onPress: async () => {
            try {
              setDeleting(true);
              await deleteReceipts(ids);
              setSelectMode(false);
              setSelectedIds(new Set());
              await load();
            } catch (e: any) {
              console.error(e);
              Alert.alert(t('history.batchDelete.deleteFailed'));
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  }, [selectedIds, load]);

  const onItemPress = useCallback(
    (item: ReceiptListRow) => {
      if (selectMode) toggleSelect(item.id);
      else router.push(`/history/${item.id}`);
    },
    [selectMode, toggleSelect, router]
  );

  const onSearchResultPress = useCallback(
    (receiptId: string) => {
      router.push(`/history/${receiptId}`);
    },
    [router]
  );

  const onProductSearchResultPress = useCallback(
    (result: ReceiptItemSearchResult) => {
      router.push(buildProductSearchResultHref(result) as Href);
    },
    [router]
  );

  const searchActive =
    normalizeReceiptItemSearchQuery(searchQuery).length > 0;
  const searchSections: { title: string; data: HistorySearchEntry[] }[] = [];
  if (itemResults.length > 0) {
    searchSections.push({
      title: t('history.search.products'),
      data: itemResults.map((result) => ({ kind: 'item', result })),
    });
  }
  if (receiptResults.length > 0) {
    searchSections.push({
      title: t('history.search.receipts'),
      data: receiptResults.map((result) => ({ kind: 'receipt', result })),
    });
  }
  const selectModeBarVisible =
    !searchActive && selectMode && rows.length > 0;
  const listBottomPad =
    TAB_BAR_CONTENT_CLEARANCE +
    Math.max(insets.bottom, 0) +
    (selectModeBarVisible ? 70 : 0);
  const headerSubtitle = buildHistorySelectModeSubtitle({
    selectMode: selectMode && !searchActive,
    selectedCount: selectedIds.size,
    defaultSubtitle: t('history.list.subtitle'),
    selectingSubtitle: t('history.list.selectingSubtitle'),
  });

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>{t('history.list.title')}</Text>
          <Text
            style={[styles.subtitle, selectMode && !searchActive && styles.subtitleSelecting]}
            accessibilityLiveRegion={selectMode ? 'polite' : undefined}
          >
            {headerSubtitle}
          </Text>
        </View>
        {!searchActive && (
          <Pressable
            onPress={toggleSelectMode}
            disabled={deleting}
            accessibilityRole="button"
            accessibilityLabel={
              selectMode
                ? t('history.batchDelete.cancel')
                : t('history.batchDelete.select')
            }
            style={({ pressed }) => [
              styles.headerBtn,
              selectMode && styles.headerBtnSelecting,
              pressed && { opacity: 0.7 },
              deleting && { opacity: 0.5 },
            ]}
          >
            <Text
              style={[
                styles.headerBtnText,
                selectMode && styles.headerBtnTextSelecting,
              ]}
            >
              {selectMode ? t('history.batchDelete.cancel') : t('history.batchDelete.select')}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={styles.searchBar}>
        <TextInput
          value={searchQuery}
          onChangeText={onSearchQueryChange}
          onSubmitEditing={onSubmitSearch}
          placeholder={t('history.search.placeholder')}
          placeholderTextColor="#888"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          blurOnSubmit
          style={styles.searchInput}
          accessibilityLabel={t('history.search.placeholder')}
        />
        {searchQuery.length > 0 && (
          <Pressable
            onPress={clearSearch}
            accessibilityRole="button"
            accessibilityLabel={t('history.search.clear')}
            hitSlop={8}
            style={({ pressed }) => [
              styles.searchClear,
              pressed && { opacity: 0.55 },
            ]}
          >
            <Text style={styles.searchClearText}>×</Text>
          </Pressable>
        )}
      </View>

      {searchActive ? (
        <SectionList
          sections={searchSections}
          keyExtractor={(entry) =>
            entry.kind === 'item'
              ? `item:${entry.result.itemId}`
              : `receipt:${entry.result.id}`
          }
          style={styles.list}
          contentContainerStyle={{ paddingBottom: listBottomPad }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionTitle}>{section.title}</Text>
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          SectionSeparatorComponent={() => <View style={styles.sectionSep} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              {searching ? (
                <>
                  <ActivityIndicator color="#555" />
                  <Text style={styles.emptyText}>{t('history.search.searching')}</Text>
                </>
              ) : (
                <Text style={styles.emptyText}>{t('history.search.noResults')}</Text>
              )}
            </View>
          }
          renderItem={({ item: entry }) => {
            if (entry.kind === 'item') {
              const result = entry.result;
              const merchant = formatHistoryMerchantDisplay(
                {
                  merchantRaw: result.merchantRaw,
                  merchantNormalized: result.merchantNormalized,
                },
                t('common.unknownMerchant')
              );
              const itemMeta = [
                result.purchaseQuantity > 1
                  ? `×${result.purchaseQuantity}`
                  : null,
                result.category,
              ].filter((value): value is string => Boolean(value));
              const totalLabel =
                result.lineTotal == null ? '—' : formatJPY(result.lineTotal);
              return (
                <Pressable
                  onPress={() => onProductSearchResultPress(result)}
                  accessibilityRole="button"
                  accessibilityLabel={buildHistoryReceiptRowA11yLabel({
                    merchant: `${t('history.search.productResultHint')}: ${result.displayName}`,
                    dateLine: `${merchant} · ${formatDate(result.transactionAt)}`,
                    totalLabel,
                  })}
                  style={({ pressed }) => [
                    styles.card,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <View style={styles.cardInner}>
                    <View style={styles.cardBody}>
                      <Text style={styles.resultTypeHint}>
                        {t('history.search.productResultHint')}
                      </Text>
                      <View style={styles.row}>
                        <Text style={styles.itemName} numberOfLines={2}>
                          {result.displayName}
                        </Text>
                        <Text style={styles.total}>{totalLabel}</Text>
                      </View>
                      <Text style={styles.meta}>
                        {merchant} · {formatDate(result.transactionAt)}
                      </Text>
                      {itemMeta.length > 0 && (
                        <Text style={styles.cats}>{itemMeta.join(' · ')}</Text>
                      )}
                    </View>
                    <IconSymbol name="chevron.right" size={18} color="#999" />
                  </View>
                </Pressable>
              );
            }

            const receipt = entry.result;
            const topCats = buildTopCategories(receipt.analysis_json, 2);
            const merchant = formatHistoryMerchantDisplay(
              receipt,
              t('common.unknownMerchant')
            );
            const metaLine = buildHistoryMetaLine(
              receipt.transaction_at,
              receipt.created_at,
              t('history.detail.taxLabel'),
              receipt.tax,
              formatDate,
              t('history.list.dateUnknown'),
              t('common.uncategorizedTag'),
              receipt.tax_is_known
            );
            return (
              <Pressable
                onPress={() => onSearchResultPress(receipt.id)}
                accessibilityRole="button"
                accessibilityLabel={buildHistoryReceiptRowA11yLabel({
                  merchant: `${t('history.search.receiptResultHint')}: ${merchant}`,
                  dateLine: metaLine,
                  totalLabel: formatJPY(receipt.total),
                })}
                style={({ pressed }) => [
                  styles.card,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <View style={styles.cardInner}>
                  <View style={styles.cardBody}>
                    <Text style={styles.resultTypeHint}>
                      {t('history.search.receiptResultHint')}
                    </Text>
                    <View style={styles.row}>
                      <Text style={styles.merchant}>{merchant}</Text>
                      <Text style={styles.total}>{formatJPY(receipt.total)}</Text>
                    </View>
                    <Text style={styles.meta}>{metaLine}</Text>
                    {topCats.length > 0 && (
                      <Text style={styles.cats}>{topCats.join(' · ')}</Text>
                    )}
                  </View>
                  <IconSymbol name="chevron.right" size={18} color="#999" />
                </View>
              </Pressable>
            );
          }}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={{ paddingBottom: listBottomPad }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>{t('history.list.empty')}</Text>
            </View>
          }
          renderItem={({ item }) => {
            const topCats = buildTopCategories(item.analysis_json, 2);
            const checked = selectedIds.has(item.id);
            const merchant = formatHistoryMerchantDisplay(
              item,
              t('common.unknownMerchant')
            );
            const metaLine = buildHistoryMetaLine(
              item.transaction_at,
              item.created_at,
              t('history.detail.taxLabel'),
              item.tax,
              formatDate,
              t('history.list.dateUnknown'),
              t('common.uncategorizedTag'),
              item.tax_is_known
            );

            return (
              <Pressable
                onPress={() => onItemPress(item)}
                accessibilityRole="button"
                accessibilityState={selectMode ? { selected: checked } : undefined}
                accessibilityLabel={buildHistoryReceiptRowA11yLabel({
                  merchant,
                  dateLine: metaLine,
                  totalLabel: formatJPY(item.total),
                })}
                style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
              >
                <View style={styles.cardInner}>
                  {selectMode && (
                    <View
                      style={[styles.checkbox, checked && styles.checkboxChecked]}
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                    >
                      {checked ? <Text style={styles.checkmark}>✓</Text> : null}
                    </View>
                  )}
                  <View style={styles.cardBody}>
                    <View style={styles.row}>
                      <Text style={styles.merchant}>{merchant}</Text>
                      <Text style={styles.total}>{formatJPY(item.total)}</Text>
                    </View>
                    <Text style={styles.meta}>{metaLine}</Text>
                    {topCats.length > 0 ? (
                      <Text style={styles.cats}>{topCats.join(' · ')}</Text>
                    ) : (
                      <Text style={styles.catsMuted}>{t('history.list.noCategoryInfo')}</Text>
                    )}
                  </View>
                  {!selectMode ? (
                    <IconSymbol name="chevron.right" size={18} color="#999" />
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}

      {selectModeBarVisible && (
        <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Pressable
            onPress={selectAll}
            disabled={deleting}
            accessibilityRole="button"
            accessibilityLabel={t('history.batchDelete.selectAll')}
            style={({ pressed }) => [styles.bottomBarBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.bottomBarBtnText}>
              {t('history.batchDelete.selectAll')}
            </Text>
          </Pressable>
          <Pressable
            onPress={onDeleteSelected}
            disabled={deleting || selectedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel={t('history.batchDelete.deleteSelected', {
              n: selectedIds.size,
            })}
            style={({ pressed }) => [
              styles.bottomBarBtn,
              styles.bottomBarBtnDanger,
              (deleting || selectedIds.size === 0) && { opacity: 0.5 },
              pressed && selectedIds.size > 0 && !deleting && { opacity: 0.8 },
            ]}
          >
            <Text style={[styles.bottomBarBtnText, styles.bottomBarBtnDangerText]}>
              {t('history.batchDelete.deleteSelected', { n: selectedIds.size })}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 18,
    paddingBottom: 8,
    flex: 1,
    backgroundColor: '#fff',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  headerLeft: {
    flex: 1,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
  },
  subtitleSelecting: {
    color: '#1677ff',
    fontWeight: '600',
  },
  headerBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  headerBtnSelecting: {
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  headerBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  headerBtnTextSelecting: {
    color: '#1677ff',
  },
  searchBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingHorizontal: 13,
    borderRadius: 12,
    backgroundColor: '#f1f1f1',
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111',
  },
  searchClear: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#d5d5d5',
  },
  searchClearText: {
    color: '#555',
    fontSize: 20,
    lineHeight: 22,
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
  sep: {
    height: 10,
  },
  sectionSep: {
    height: 8,
  },
  sectionTitle: {
    paddingTop: 4,
    paddingBottom: 8,
    fontSize: 13,
    fontWeight: '700',
    color: '#666',
  },
  emptyState: {
    paddingTop: 30,
    alignItems: 'center',
    gap: 10,
  },
  emptyText: {
    color: '#666',
  },
  card: {
    backgroundColor: '#f3f3f3',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  cardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#999',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  checkmark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  resultTypeHint: {
    marginBottom: 4,
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  merchant: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  itemName: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    fontWeight: '700',
  },
  total: {
    fontSize: 16,
    fontWeight: '700',
  },
  meta: {
    marginTop: 6,
    fontSize: 13,
    color: '#666',
  },
  cats: {
    marginTop: 6,
    fontSize: 13,
    color: '#333',
    fontWeight: '600',
  },
  catsMuted: {
    marginTop: 6,
    fontSize: 13,
    color: '#999',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
    backgroundColor: '#fff',
  },
  bottomBarBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  bottomBarBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  bottomBarBtnDanger: {
    borderRadius: 8,
    backgroundColor: '#fff0f0',
  },
  bottomBarBtnDangerText: {
    color: '#c00',
    fontWeight: '800',
  },
});
