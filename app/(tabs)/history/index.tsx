import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter, type Href } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { CategoryIdentity } from '@/components/CategoryIdentity';
import { MerunoDisclosureIndicator } from '@/components/MerunoDisclosureIndicator';
import {
  MerunoGroupedList,
  MerunoGroupedRow,
} from '@/components/MerunoGroupedList';
import { MerchantIdentityTile } from '@/components/MerchantIdentityTile';
import { deleteReceipts, getReceiptsDatabase, listAllReceiptsForCurrentOwnerPurchaseTruth, listReceipts, type ReceiptListRow } from '@/lib/db';
import { formatJPY } from '@/lib/formatJPY';
import { getCurrentLocale, t } from '@/lib/i18n';
import { getCategoryLabel } from '@/lib/categoryPalette';
import {
  buildHistoryReceiptRowA11yLabel,
  buildHistorySelectModeSubtitle,
  formatHistoryMerchantDisplay,
} from '@/lib/historyPresentation';
import {
  buildHistoryPurchaseTruthView,
  HISTORY_PURCHASE_TRUTH_LOAD_LIMIT,
  projectHistorySearchToPurchaseTruth,
  resolveHistoryPurchaseDeleteIds,
} from '@/lib/historyPurchaseTruth';
import { buildHistoryMonthSections } from '@/lib/historyMonthPresentation';
import { buildTopCategories, buildHistoryMetaLine } from '@/lib/receiptListHelpers';
import { formatDate } from '@/lib/formatDate';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
  UI_TYPOGRAPHY,
} from '@/lib/uiTokens';
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
  buildPersonalAwareProductSearchResultHref,
} from '@/lib/personalProductReturnTarget';
import {
  beginAsyncRequestGeneration,
  invalidateAsyncRequestGeneration,
  shouldApplyAsyncRequestGeneration,
} from '@/lib/asyncRequestGeneration';
import {
  loadPersonalProductEndpointInventoryWithDb,
  type PersonalProductEndpointInventory,
} from '@/lib/personalProductEndpointInventory';

/** Matches Home tab content clearance so rows clear the bottom tab bar. */
const TAB_BAR_CONTENT_CLEARANCE = UI_LAYOUT.tabContentClearance;

type HistoryProjectedItemSearchResult = ReceiptItemSearchResult & {
  personalEvidenceReceiptId: string;
};

type HistorySearchEntry =
  | { kind: 'item'; result: HistoryProjectedItemSearchResult }
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
  const [itemResults, setItemResults] = useState<HistoryProjectedItemSearchResult[]>([]);
  const [receiptResults, setReceiptResults] = useState<ReceiptListRow[]>([]);
  const [personalInventory, setPersonalInventory] =
    useState<PersonalProductEndpointInventory | null>(null);
  const searchQueryRef = useRef('');
  const searchRequestSequence = useRef(0);
  const lastCompletedNormalizedQueryRef = useRef('');
  const purchaseTruthRef = useRef<ReturnType<
    typeof buildHistoryPurchaseTruthView
  > | null>(null);
  const personalInventoryGenerationRef = useRef(0);

  const loadPersonalInventory = useCallback(async () => {
    const generation = beginAsyncRequestGeneration(personalInventoryGenerationRef);
    try {
      const db = await getReceiptsDatabase();
      const inventoryResult = await loadPersonalProductEndpointInventoryWithDb(db);
      if (
        !shouldApplyAsyncRequestGeneration(
          generation,
          personalInventoryGenerationRef.current
        )
      ) {
        return;
      }
      setPersonalInventory(
        inventoryResult.status === 'ready' ? inventoryResult.inventory : null
      );
    } catch (e) {
      console.error('[History] personal inventory enrichment skipped', e);
      if (
        !shouldApplyAsyncRequestGeneration(
          generation,
          personalInventoryGenerationRef.current
        )
      ) {
        return;
      }
      setPersonalInventory(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const stored = await listReceipts(HISTORY_PURCHASE_TRUTH_LOAD_LIMIT);
      const truth = buildHistoryPurchaseTruthView(stored);
      purchaseTruthRef.current = truth;
      setRows(truth.visibleRows);
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

      // Ensure purchase-truth groups exist for projection (fresh load if needed).
      let truth = purchaseTruthRef.current;
      if (!truth) {
        const stored = await listReceipts(HISTORY_PURCHASE_TRUTH_LOAD_LIMIT);
        truth = buildHistoryPurchaseTruthView(stored);
        purchaseTruthRef.current = truth;
        setRows(truth.visibleRows);
      }

      const withProvenance = (
        outcome.itemResults as ReceiptItemSearchResult[]
      ).map((result) => ({
        ...result,
        personalEvidenceReceiptId: result.receiptId,
      }));
      const projected = projectHistorySearchToPurchaseTruth(
        {
          itemResults: withProvenance as HistoryProjectedItemSearchResult[],
          receiptResults: outcome.receiptResults as ReceiptListRow[],
        },
        truth.selection
      );

      lastCompletedNormalizedQueryRef.current = outcome.normalizedQuery;
      setItemResults(projected.itemResults);
      setReceiptResults(projected.receiptResults);
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
      void loadPersonalInventory();
      const currentQuery = searchQueryRef.current;
      if (normalizeReceiptItemSearchQuery(currentQuery)) {
        void executeSearch(currentQuery);
      }
      return () => {
        invalidateAsyncRequestGeneration(personalInventoryGenerationRef);
      };
    }, [executeSearch, load, loadPersonalInventory])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      load(),
      loadPersonalInventory(),
      normalizeReceiptItemSearchQuery(searchQueryRef.current)
        ? executeSearch(searchQueryRef.current)
        : Promise.resolve(),
    ]);
    setRefreshing(false);
  }, [executeSearch, load, loadPersonalInventory]);

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
    const purchaseIds = Array.from(selectedIds);
    if (purchaseIds.length === 0) return;

    Alert.alert(
      t('history.batchDelete.confirmTitle'),
      t('history.batchDelete.confirmMessage', { n: purchaseIds.length }),
      [
        { text: t('history.batchDelete.confirmCancel'), style: 'cancel' },
        {
          text: t('history.batchDelete.confirmDelete'),
          style: 'destructive',
          onPress: async () => {
            try {
              setDeleting(true);
              const stored = await listAllReceiptsForCurrentOwnerPurchaseTruth();
              const deleteIds = resolveHistoryPurchaseDeleteIds(
                purchaseIds,
                stored
              );
              await deleteReceipts(deleteIds);
              setSelectMode(false);
              setSelectedIds(new Set());
              await load();
            } catch (e: any) {
              console.error(e);
              Alert.alert(t('history.batchDelete.deleteFailed'));
              await load();
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
    (result: HistoryProjectedItemSearchResult) => {
      router.push(
        buildPersonalAwareProductSearchResultHref(
          {
            source: {
              receiptId: result.receiptId,
              itemId: result.itemId,
              skuKey: result.skuKey,
              canonicalProductName: result.canonicalProductName,
              productFamilyKey: result.productFamilyKey,
            },
            sourceIndex: result.sourceIndex,
            personalEvidenceReceiptId: result.personalEvidenceReceiptId,
          },
          personalInventory
        ) as Href
      );
    },
    [router, personalInventory]
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
  const historySections = useMemo(
    () => buildHistoryMonthSections(rows, getCurrentLocale()),
    [rows]
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap }]}>
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
        <MaterialIcons
          name="search"
          size={20}
          color={UI_COLORS.textMuted}
          importantForAccessibility="no"
        />
        <TextInput
          value={searchQuery}
          onChangeText={onSearchQueryChange}
          onSubmitEditing={onSubmitSearch}
          placeholder={t('history.search.placeholder')}
          placeholderTextColor={UI_COLORS.textMuted}
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
          renderItem={({ item: entry, index, section }) => {
            const showDivider = index < section.data.length - 1;
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
                result.category
                  ? getCategoryLabel(result.category)
                  : null,
              ].filter((value): value is string => Boolean(value));
              const totalLabel =
                result.lineTotal == null ? '—' : formatJPY(result.lineTotal);
              return (
                <MerunoGroupedRow
                  onPress={() => onProductSearchResultPress(result)}
                  accessibilityLabel={buildHistoryReceiptRowA11yLabel({
                    merchant: `${t('history.search.productResultHint')}: ${result.displayName}`,
                    dateLine: `${merchant} · ${formatDate(result.transactionAt)}`,
                    totalLabel,
                  })}
                  showDivider={showDivider}
                  minHeight={92}
                >
                  {({ pressed }) => (
                    <View style={styles.rowInner}>
                      {result.category ? (
                        <CategoryIdentity
                          category={result.category}
                          compact
                          showLabel={false}
                        />
                      ) : null}
                      <View style={styles.rowBody}>
                        <Text style={styles.resultTypeHint}>
                          {t('history.search.productResultHint')}
                        </Text>
                        <View style={styles.primaryLine}>
                          <Text style={styles.itemName} numberOfLines={2}>
                            {result.displayName}
                          </Text>
                          <Text style={styles.total}>{totalLabel}</Text>
                        </View>
                        <Text style={styles.meta}>
                          {merchant} · {formatDate(result.transactionAt)}
                        </Text>
                        {itemMeta.length > 0 && (
                          <Text style={styles.categories}>{itemMeta.join(' · ')}</Text>
                        )}
                      </View>
                      <MerunoDisclosureIndicator
                        kind="crossEntity"
                        pressed={pressed}
                      />
                    </View>
                  )}
                </MerunoGroupedRow>
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
              <MerunoGroupedRow
                onPress={() => onSearchResultPress(receipt.id)}
                accessibilityLabel={buildHistoryReceiptRowA11yLabel({
                  merchant: `${t('history.search.receiptResultHint')}: ${merchant}`,
                  dateLine: metaLine,
                  totalLabel: formatJPY(receipt.total),
                })}
                showDivider={showDivider}
                minHeight={92}
              >
                <View style={styles.rowInner}>
                  <MerchantIdentityTile
                    merchant={merchant}
                    merchantKey={receipt.merchant_normalized}
                    size={36}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.resultTypeHint}>
                      {t('history.search.receiptResultHint')}
                    </Text>
                    <View style={styles.primaryLine}>
                      <Text style={styles.merchant}>{merchant}</Text>
                      <Text style={styles.total}>{formatJPY(receipt.total)}</Text>
                    </View>
                    <Text style={styles.meta}>{metaLine}</Text>
                    {topCats.length > 0 && (
                      <Text style={styles.categories}>{topCats.join(' · ')}</Text>
                    )}
                  </View>
                </View>
              </MerunoGroupedRow>
            );
          }}
        />
      ) : (
        <FlatList
          data={historySections}
          keyExtractor={(section) => section.title}
          style={styles.list}
          contentContainerStyle={{ paddingBottom: listBottomPad }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ItemSeparatorComponent={() => <View style={styles.monthGap} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>{t('history.list.empty')}</Text>
            </View>
          }
          renderItem={({ item: section }) => {
            return (
              <View>
                <Text style={styles.monthTitle}>{section.title}</Text>
                <MerunoGroupedList>
                  {section.data.map((item, index) => {
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
                      <MerunoGroupedRow
                        key={item.id}
                        onPress={() => onItemPress(item)}
                        accessibilityState={
                          selectMode ? { selected: checked } : undefined
                        }
                        accessibilityLabel={buildHistoryReceiptRowA11yLabel({
                          merchant,
                          dateLine: metaLine,
                          totalLabel: formatJPY(item.total),
                        })}
                        showDivider={index < section.data.length - 1}
                        minHeight={92}
                      >
                        <View style={styles.rowInner}>
                          {selectMode && (
                            <View
                              style={[
                                styles.checkbox,
                                checked && styles.checkboxChecked,
                              ]}
                              accessibilityElementsHidden
                              importantForAccessibility="no-hide-descendants"
                            >
                              {checked ? (
                                <Text style={styles.checkmark}>✓</Text>
                              ) : null}
                            </View>
                          )}
                          <MerchantIdentityTile
                            merchant={merchant}
                            merchantKey={item.merchant_normalized}
                            size={38}
                          />
                          <View style={styles.rowBody}>
                            <View style={styles.primaryLine}>
                              <Text style={styles.merchant} numberOfLines={1}>
                                {merchant}
                              </Text>
                              <Text style={styles.total} numberOfLines={1}>
                                {formatJPY(item.total)}
                              </Text>
                            </View>
                            <Text style={styles.meta} numberOfLines={1}>
                              {metaLine}
                            </Text>
                            {topCats.length > 0 ? (
                              <Text style={styles.categories} numberOfLines={1}>
                                {topCats.join(' · ')}
                              </Text>
                            ) : (
                              <Text style={styles.categoriesMuted} numberOfLines={1}>
                                {t('history.list.noCategoryInfo')}
                              </Text>
                            )}
                          </View>
                        </View>
                      </MerunoGroupedRow>
                    );
                  })}
                </MerunoGroupedList>
              </View>
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
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingBottom: 8,
    flex: 1,
    backgroundColor: UI_COLORS.background,
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
    fontSize: UI_TYPOGRAPHY.pageTitle,
    fontWeight: '700',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: UI_COLORS.textSecondary,
  },
  subtitleSelecting: {
    color: UI_COLORS.accent,
    fontWeight: '600',
  },
  headerBtn: {
    minHeight: UI_LAYOUT.controlMinHeight,
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
    color: UI_COLORS.textPrimary,
  },
  headerBtnTextSelecting: {
    color: UI_COLORS.accent,
  },
  searchBar: {
    minHeight: UI_LAYOUT.controlMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingHorizontal: 13,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    gap: 9,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    fontSize: 16,
    color: UI_COLORS.textPrimary,
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
    backgroundColor: UI_COLORS.background,
  },
  sectionSep: {
    height: 8,
  },
  sectionTitle: {
    paddingTop: 4,
    paddingBottom: 8,
    fontSize: 13,
    fontWeight: '700',
    color: UI_COLORS.textSecondary,
  },
  monthTitle: {
    paddingTop: 4,
    paddingBottom: 10,
    backgroundColor: UI_COLORS.background,
    color: UI_COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  monthGap: {
    height: 12,
    backgroundColor: UI_COLORS.background,
  },
  emptyState: {
    paddingTop: 30,
    alignItems: 'center',
    gap: 10,
  },
  emptyText: {
    color: UI_COLORS.textSecondary,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowBody: {
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
    backgroundColor: UI_COLORS.textPrimary,
    borderColor: UI_COLORS.textPrimary,
  },
  checkmark: {
    color: UI_COLORS.background,
    fontSize: 14,
    fontWeight: '800',
  },
  primaryLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  resultTypeHint: {
    marginBottom: 4,
    fontSize: 11,
    fontWeight: '700',
    color: UI_COLORS.textMuted,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  merchant: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
    color: UI_COLORS.textPrimary,
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
    color: UI_COLORS.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  meta: {
    marginTop: 6,
    fontSize: 13,
    color: UI_COLORS.textSecondary,
  },
  categories: {
    marginTop: 5,
    fontSize: 13,
    color: UI_COLORS.textSecondary,
    fontWeight: '400',
  },
  categoriesMuted: {
    marginTop: 5,
    fontSize: 13,
    color: UI_COLORS.textMuted,
    fontWeight: '400',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.background,
  },
  bottomBarBtn: {
    paddingVertical: 10,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
  },
  bottomBarBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
  },
  bottomBarBtnDanger: {
    borderRadius: 8,
    backgroundColor: '#fff0f0',
  },
  bottomBarBtnDangerText: {
    color: UI_COLORS.destructive,
    fontWeight: '800',
  },
});
