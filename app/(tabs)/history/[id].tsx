// app/(tabs)/history/[id].tsx
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CategoryIdentityIcon } from '@/components/CategoryIdentityIcon';
import { CategoryRatioRow } from '@/components/CategoryRatioRow';
import { MerunoDisclosureIndicator } from '@/components/MerunoDisclosureIndicator';
import {
  MerunoGroupedList,
  MerunoGroupedRow,
} from '@/components/MerunoGroupedList';
import { MerchantIdentityTile } from '@/components/MerchantIdentityTile';
import {
  deleteReceipts,
  getReceipt,
  getReceiptsDatabase,
  listReceipts,
  updateReceipt,
  type ReceiptRow,
} from '@/lib/db';
import { selectAnalyticsReceipts } from '@/lib/analyticsReceiptSelection';
import {
  expandHistoryPurchaseDeleteIds,
  HISTORY_PURCHASE_TRUTH_LOAD_LIMIT,
} from '@/lib/historyPurchaseTruth';
import { formatDate } from '@/lib/formatDate';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import { navigateBackOrHistory } from '@/lib/navigationBack';
import {
  shouldApplyReceiptDetailLoadUpdate,
} from '@/lib/receiptDetailLoadLifecycle';
import {
  loadPersonalProductEndpointInventoryWithDb,
  type PersonalProductEndpointInventory,
} from '@/lib/personalProductEndpointInventory';
import {
  buildPersonalAwareAggregatableProductDetailHref,
  resolveReceiptItemPersistedSourceIndex,
} from '@/lib/personalProductReturnTarget';
import {
  productDetailTargetSourceFromReceiptItem,
} from '@/lib/productDetailTarget';
import { learnFromUserEdit } from '@/lib/receiptEnricher';
import { upsertProductDictionary } from '@/lib/productDictionary';
import { upsertProductNameAlias } from '@/lib/productAlias';
import { PRODUCT_CATEGORIES, normalizePersistedProductCategory, type ProductCategory } from '@/lib/productCategory';
import { stampUserClassificationProvenance } from '@/lib/productTaxonomy';
import { getCategoryLabel, getItemTagDisplay } from '@/lib/categoryPalette';
import { normalizeReceiptItemName } from '@/lib/productNormalizer';
import { mapLegacyCategoryToV1, buildAnalysisTags } from '@/lib/categoryTaxonomyV1';
import { applyProductIdentityToItem } from '@/lib/receiptItemIdentity';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
} from '@/lib/uiTokens';
import {
  applyUserLineAmountEdit,
  itemAmountForAnalytics,
} from '@/lib/receiptDiscountAllocation';
import {
  amountCorrectionInput,
  applyItemFieldCorrections,
  categoryCorrectionInput,
  quantityCorrectionInput,
} from '@/lib/userCorrections';

// ====== 解析后的结构（和 Home 里的分析结构保持一致）======
type ReceiptItem = {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  category?: string;
};

type ReceiptAnalysis = {
  merchant?: string;
  items: ReceiptItem[];
  total: number;
  tax: number;
  currency: string;
  [k: string]: any;
};

function safeParseAnalysis(json: string | null): ReceiptAnalysis | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    return obj as ReceiptAnalysis;
  } catch {
    return null;
  }
}

function safeParseItems(json: string | null): ReceiptItem[] | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr as ReceiptItem[];
  } catch {
    return null;
  }
}

function toNum(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round0(n: number) {
  // 日元不需要小数；如果以后要支持小数，改这里即可
  return Math.round(n);
}

/** Amount for summary: shared analytics resolver (user override > effective > gross). */
function itemLineAmountForSummary(it: any): number {
  const amount = itemAmountForAnalytics(it);
  if (amount > 0) return round0(amount);
  const qRaw = toNum(it.quantity, 0);
  const q = qRaw > 0 ? qRaw : 1;
  const up = toNum(it.unitPrice ?? it.unit_price, 0);
  return up > 0 ? round0(up * q) : 0;
}

/**
 * 分类汇总：信任已落库的语义分类（兼容旧 enum / 店铺词）。
 * 不得在 stored=uncategorized 时用商品名再发明一个不同类别。
 */
function buildCategorySummary(
  analysis: ReceiptAnalysis | { items: ReceiptItem[] } | null,
  debug?: { source: string }
): { category: string; amount: number }[] {
  const map = new Map<string, number>();
  if (!analysis?.items?.length) return [];

  for (const it of analysis.items) {
    const status = (it as any).classification_status as string | undefined;
    if (status !== undefined && status !== 'ok' && status !== 'fallback') continue;
    const rawCat =
      (typeof (it as any).category === 'string' && (it as any).category) ||
      (typeof (it as any).categoryKey === 'string' && (it as any).categoryKey) ||
      '';
    const cat = normalizePersistedProductCategory(rawCat, typeof it.name === 'string' ? it.name : undefined);
    const amt = itemLineAmountForSummary(it);
    map.set(cat, (map.get(cat) ?? 0) + amt);
  }

  const arr = Array.from(map.entries()).map(([category, amount]) => ({ category, amount }));
  arr.sort((a, b) => b.amount - a.amount);
  if (__DEV__ && debug) {
    // eslint-disable-next-line no-console
    console.log('[Detail][CategorySummary] summary', arr);
  }
  return arr;
}

export default function ReceiptDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState<ReceiptRow | null>(null);
  const [personalInventory, setPersonalInventory] =
    useState<PersonalProductEndpointInventory | null>(null);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const routeIdRef = useRef<string | undefined>(id);

  useEffect(() => {
    routeIdRef.current = id;
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  const loadUpdateAllowed = useCallback(
    (generation: number, capturedReceiptId: string) =>
      shouldApplyReceiptDetailLoadUpdate({
        mounted: mountedRef.current,
        capturedGeneration: generation,
        currentGeneration: loadGenerationRef.current,
        capturedReceiptId,
        currentReceiptId:
          routeIdRef.current != null ? String(routeIdRef.current) : null,
      }),
    []
  );

  const onBack = useCallback(() => {
    navigateBackOrHistory(router);
  }, [router]);

  // ====== 商品编辑 Modal 状态 ======
  const [itemEditOpen, setItemEditOpen] = useState(false);
  const [editingItemIndex, setEditingItemIndex] = useState<number>(-1);
  const [draftCategory, setDraftCategory] = useState('');
  const [draftQuantity, setDraftQuantity] = useState('');
  const [draftLineTotal, setDraftLineTotal] = useState('');
  const [savingItem, setSavingItem] = useState(false);

  // 分类选项（使用grocery分类，包含other_grocery作为fallback）
  const categoryOptions = PRODUCT_CATEGORIES;

  const analysis = useMemo(() => {
    if (!receipt) return null;
    return safeParseAnalysis(receipt.analysis_json);
  }, [receipt]);

  const analysisOutputs = useMemo(() => {
    if (!receipt) return null;
    try {
      const obj = JSON.parse(receipt.analysis_json || '{}');
      return {
        analysis_level: obj?.analysis_level,
        analysis_outputs_v1: obj?.analysis_outputs_v1,
      };
    } catch {
      return null;
    }
  }, [receipt]);

  // 优先使用 user_items_json，否则使用 analysis.items
  const displayItems = useMemo(() => {
    if (!receipt) return [];
    const userItems = safeParseItems(receipt.user_items_json);
    if (userItems && userItems.length > 0) {
      return userItems;
    }
    return analysis?.items ?? [];
  }, [receipt, analysis]);

  // 基于 displayItems 构建分类汇总和总额
  const displayAnalysis = useMemo(() => {
    return {
      items: displayItems,
      total: displayItems.reduce((sum, it) => sum + toNum(it.lineTotal, 0), 0),
    };
  }, [displayItems]);

  const categorySummary = useMemo(() => {
    const userItems = receipt ? safeParseItems(receipt.user_items_json) : null;
    const source =
      userItems && userItems.length > 0 ? 'user_items_json' : 'analysis_json.items';
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[Detail][CategorySummary] source', source, 'items', displayAnalysis.items.length);
    }
    return buildCategorySummary(displayAnalysis, __DEV__ ? { source } : undefined);
  }, [displayAnalysis, receipt]);

  const merchant =
    receipt?.merchant_raw ||
    receipt?.merchant_normalized ||
    analysis?.merchant ||
    t('common.unknownMerchant');

  const currency = receipt?.currency || analysis?.currency || 'JPY';

  // 显示总额：优先使用 user_items_json 计算的总和，否则使用 receipt.total
  const displayTotal = useMemo(() => {
    if (receipt?.user_items_json) {
      return round0(displayAnalysis.total);
    }
    return receipt?.total ?? 0;
  }, [receipt, displayAnalysis]);

  const load = useCallback(async () => {
    if (!id) {
      if (mountedRef.current) {
        setLoading(false);
      }
      return;
    }

    const generation = ++loadGenerationRef.current;
    const capturedId = String(id);

    if (loadUpdateAllowed(generation, capturedId)) {
      setLoading(true);
    }

    try {
      const [receiptResult, inventoryResult] = await Promise.allSettled([
        getReceipt(capturedId),
        (async () => {
          try {
            const db = await getReceiptsDatabase();
            return await loadPersonalProductEndpointInventoryWithDb(db);
          } catch (personalInventoryError) {
            console.error(
              '[ReceiptDetail] personal inventory enrichment skipped',
              personalInventoryError
            );
            return null;
          }
        })(),
      ]);

      if (!loadUpdateAllowed(generation, capturedId)) {
        return;
      }

      if (receiptResult.status === 'fulfilled') {
        setReceipt(receiptResult.value ?? null);
        if (
          inventoryResult.status === 'fulfilled' &&
          inventoryResult.value?.status === 'ready'
        ) {
          setPersonalInventory(inventoryResult.value.inventory);
        } else {
          setPersonalInventory(null);
        }
      } else {
        console.error(receiptResult.reason);
        Alert.alert(t('history.errors.loadTitle'), t('history.detail.loadMessage'));
        setReceipt(null);
        setPersonalInventory(null);
      }
    } catch (e: any) {
      if (!loadUpdateAllowed(generation, capturedId)) {
        return;
      }
      console.error(e);
      Alert.alert(t('history.errors.loadTitle'), t('history.detail.loadMessage'));
      setReceipt(null);
      setPersonalInventory(null);
    } finally {
      if (loadUpdateAllowed(generation, capturedId)) {
        setLoading(false);
      }
    }
  }, [id, loadUpdateAllowed]);

  useEffect(() => {
    load();
  }, [load]);

  const openItemEditor = (index: number) => {
    if (index < 0 || index >= displayItems.length) return;
    const item = displayItems[index];
    setEditingItemIndex(index);
    setDraftCategory(normalizePersistedProductCategory(item.category, item.name));
    setDraftQuantity(String(item.quantity || 1));
    setDraftLineTotal(String(item.lineTotal || 0));
    setItemEditOpen(true);
  };

  const closeItemEditor = () => {
    if (savingItem) return;
    setItemEditOpen(false);
    setEditingItemIndex(-1);
    setDraftCategory('');
    setDraftQuantity('');
    setDraftLineTotal('');
  };

  const onSaveItemEdit = async () => {
    if (!receipt || editingItemIndex < 0 || editingItemIndex >= displayItems.length) return;

    // 验证输入
    const quantity = toNum(draftQuantity.trim(), 0);
    if (quantity < 1) {
      Alert.alert(t('history.detail.inputErrorTitle'), t('history.detail.qtyError'));
      return;
    }

    const lineTotal = toNum(draftLineTotal.trim(), 0);
    if (lineTotal <= 0) {
      Alert.alert(t('history.detail.inputErrorTitle'), t('history.detail.totalError'));
      return;
    }

    // 更新商品列表
    const updatedItems = [...displayItems];
    const existingItem = updatedItems[editingItemIndex] as ReceiptItem & Record<string, unknown>;
    const finalCategory = (draftCategory.trim() || 'uncategorized') as ProductCategory;
    const beforeQuantity = Number(existingItem.quantity);
    const beforeAmount = itemAmountForAnalytics(existingItem as any);
    const beforeCategory =
      typeof existingItem.category === 'string' && existingItem.category.trim()
        ? existingItem.category.trim()
        : 'uncategorized';
    const itemSourceIndex =
      typeof (existingItem as any).review_source_index === 'number'
        ? (existingItem as any).review_source_index
        : typeof (existingItem as any).source_index === 'number'
          ? (existingItem as any).source_index
          : editingItemIndex;

    const withIdentity = applyProductIdentityToItem({
      ...existingItem,
      quantity: round0(quantity),
      category: finalCategory,
    }, {
      finalName: existingItem.name,
      finalCategory,
      merchantName: receipt.merchant_raw,
      classificationBrand: (existingItem as any).brand,
      useExistingClassificationEvidence: true,
    });
    // Keep user-layer money fields coherent so analytics prefers the edit (not stale effective).
    let nextItem = {
      ...applyUserLineAmountEdit(
        withIdentity as ReceiptItem & Record<string, unknown>,
        round0(lineTotal)
      ),
      ...stampUserClassificationProvenance(),
      ...(round0(quantity) !==
      (Number.isFinite(beforeQuantity) && beforeQuantity > 0 ? beforeQuantity : 1)
        ? { quantityUserEdited: true }
        : {}),
    } as ReceiptItem & Record<string, unknown>;

    nextItem = applyItemFieldCorrections(nextItem, [
      quantityCorrectionInput({
        beforeQuantity: Number.isFinite(beforeQuantity) && beforeQuantity > 0 ? beforeQuantity : 1,
        afterQuantity: round0(quantity),
        previouslyUserEdited: (existingItem as any).quantityUserEdited === true,
        itemSourceIndex,
      }),
      amountCorrectionInput({
        beforeAmount: Number.isFinite(beforeAmount) ? Math.round(beforeAmount) : 0,
        afterAmount: round0(lineTotal),
        previouslyUserEdited: (existingItem as any).amountUserEdited === true,
        itemSourceIndex,
      }),
      categoryCorrectionInput({
        beforeCategory,
        afterCategory: finalCategory,
        beforeItem: existingItem as {
          classification_source?: unknown;
          classification_version?: unknown;
          taxonomy_version?: unknown;
        },
        itemSourceIndex,
      }),
    ]);

    updatedItems[editingItemIndex] = nextItem;

    try {
      setSavingItem(true);
      
      // 学习用户编辑的分类
      const editedItem = updatedItems[editingItemIndex];
      if (editedItem && editedItem.name && editedItem.category) {
        await learnFromUserEdit(
          editedItem.name,
          editedItem.category,
          receipt?.merchant_raw ?? null
        );
        // Also write into product_dictionary (highest trust: user edit)
        try {
          const norm = normalizeReceiptItemName(editedItem.name);
          const v1 = mapLegacyCategoryToV1(editedItem.category);
          await upsertProductDictionary({
            normalized_name: norm.normalized_name,
            canonical_name: editedItem.name.trim(),
            category_main: v1.main,
            category_sub: v1.sub,
            analysis_tags: buildAnalysisTags(v1),
            source_type: 'manual',
            confidence: 1.0,
            minConfidenceToWrite: 0,
          });
          await upsertProductNameAlias({
            alias_normalized: norm.normalized_name,
            merchant_hint: receipt?.merchant_raw ?? null,
            canonical_name: editedItem.name.trim(),
            category_main: v1.main,
            category_sub: v1.sub,
            analysis_tags: buildAnalysisTags(v1),
            confidence: 1.0,
            source: 'manual',
          });
        } catch {
          // ignore
        }
      }

      await updateReceipt({
        id: receipt.id,
        user_edited: 1,
        user_items_json: JSON.stringify(updatedItems),
      });

      setItemEditOpen(false);
      await load();
      Alert.alert(t('history.detail.savedTitle'));
    } catch (e: any) {
      console.error(e);
      Alert.alert(t('history.detail.saveFailedTitle'), t('history.detail.retry'));
    } finally {
      setSavingItem(false);
    }
  };

  const onDelete = async () => {
    if (!receipt) return;

    Alert.alert(
      t('history.detail.deleteConfirmTitle'),
      t('history.detail.deleteConfirmMessage'),
      [
        { text: t('history.detail.edit.cancel'), style: 'cancel' },
        {
          text: t('history.batchDelete.confirmDelete'),
          style: 'destructive',
          onPress: async () => {
            try {
              // Expand confirmed high-confidence duplicate group so the
              // purchase cannot immediately reappear from a hidden scan.
              const stored = await listReceipts(HISTORY_PURCHASE_TRUTH_LOAD_LIMIT);
              const selection = selectAnalyticsReceipts(stored);
              const deleteIds = expandHistoryPurchaseDeleteIds(
                [receipt.id],
                selection.highConfidenceDuplicateGroups
              );
              await deleteReceipts(deleteIds);
              Alert.alert(t('history.detail.deletedTitle'));
              navigateBackOrHistory(router);
            } catch (e: any) {
              console.error(e);
              Alert.alert(t('history.detail.deleteFailedTitle'), t('history.detail.retry'));
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGapCompact }]}>
        <View style={styles.navigationHeader}>
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={t('history.detail.back')}
            style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.55 }]}
            hitSlop={8}
          >
            <Text style={styles.backText}>{t('history.detail.back')}</Text>
          </Pressable>
          <Text style={styles.navigationTitle}>{t('history.detail.title')}</Text>
          <View style={styles.navigationSpacer} />
        </View>
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={{ marginTop: 10 }}>{t('history.detail.loading')}</Text>
        </View>
      </View>
    );
  }

  if (!receipt) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGapCompact }]}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t('history.detail.back')}
          style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.55 }]}
          hitSlop={8}
        >
          <Text style={styles.backText}>{t('history.detail.back')}</Text>
        </Pressable>
        <View style={styles.center}>
          <Text>{t('history.detail.notFound')}</Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <View style={[styles.screen, { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGapCompact }]}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t('history.detail.back')}
          style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.55 }]}
          hitSlop={8}
        >
          <Text style={styles.backText}>{t('history.detail.back')}</Text>
        </Pressable>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: 28 + Math.max(insets.bottom, 0) }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.receiptHero}>
          <View style={styles.receiptHeroBody}>
            <View style={styles.merchantSummaryRow}>
              <MerchantIdentityTile
                merchant={merchant}
                merchantKey={receipt.merchant_normalized}
                size={42}
              />
              <View style={styles.merchantSummaryText}>
                <Text style={styles.merchant}>{merchant}</Text>
                <Text style={styles.date}>
                  {receipt.transaction_at
                    ? formatDate(receipt.transaction_at)
                    : t('history.detail.dateUnknown')}
                </Text>
              </View>
            </View>
            <View style={styles.totalRow}>
              <View>
                <Text style={styles.total} accessibilityRole="text">
                  {formatJPY(displayTotal)}
                </Text>
                <Text style={styles.totalLabel}>{t('history.detail.totalLabel')}</Text>
              </View>
              <Text style={styles.tax}>
                {t('history.detail.taxLabel')}{' '}
                {receipt.tax_is_known === 1 && receipt.tax != null && Number.isFinite(receipt.tax)
                  ? formatJPY(receipt.tax)
                  : t('common.uncategorizedTag')}
              </Text>
            </View>
            {receipt.user_edited === 1 && receipt.user_items_json && (
              <Text style={styles.overrideHint}>{t('history.detail.editedHint')}</Text>
            )}
          </View>
        </View>

        {/* 分类汇总 */}
        <Text style={styles.h2}>{t('history.detail.categorySummaryTitle')}</Text>
        <MerunoGroupedList>
          {categorySummary.length === 0 ? (
            <View style={styles.emptyGroupedRow}>
              <Text style={{ color: UI_COLORS.textSecondary }}>{t('history.detail.noCategoryInfo')}</Text>
            </View>
          ) : (
            categorySummary.map((x, index) => (
              <MerunoGroupedRow
                key={x.category}
                showDivider={index < categorySummary.length - 1}
                dividerInset={58}
                minHeight={76}
              >
                <CategoryRatioRow
                  category={x.category}
                  amount={formatJPY(x.amount)}
                  percent={
                    displayTotal > 0
                      ? Math.max(0, (x.amount / displayTotal) * 100)
                      : 0
                  }
                />
              </MerunoGroupedRow>
            ))
          )}
        </MerunoGroupedList>

        {/* 商品明细 */}
        <Text style={styles.h2}>{t('history.detail.itemsTitle')}</Text>

        {displayItems.length > 0 ? (
          <MerunoGroupedList>
            {displayItems.map((it, idx) => {
              const sourceIndex = resolveReceiptItemPersistedSourceIndex(
                it as unknown as Record<string, unknown>,
                idx
              );
              const productHref = buildPersonalAwareAggregatableProductDetailHref(
                {
                  source: productDetailTargetSourceFromReceiptItem(
                    it as unknown as Record<string, unknown>,
                    receipt.id,
                    sourceIndex
                  ),
                  sourceIndex,
                },
                personalInventory
              );
              const tag = getItemTagDisplay(it as any);
              return (
                <MerunoGroupedRow
                  key={`${it.name}-${idx}`}
                  showDivider={idx < displayItems.length - 1}
                  dividerInset={58}
                  minHeight={92}
                >
                  <View style={styles.itemRow}>
                    {productHref ? (
                      <Pressable
                        onPress={() => router.push(productHref as Href)}
                        accessibilityRole="button"
                        accessibilityLabel={t('history.detail.viewProductHistory')}
                        style={({ pressed }) => [
                          styles.itemProductLink,
                          pressed && styles.itemProductLinkPressed,
                        ]}
                      >
                        {({ pressed }) => (
                          <>
                            <CategoryIdentityIcon
                              category={it.category ?? 'uncategorized'}
                              size={30}
                            />
                            <View style={styles.itemText}>
                              <Text style={styles.itemName}>{it.name}</Text>
                              <Text style={styles.itemMeta}>
                                {t('history.detail.quantityShort')} {it.quantity} · {t('history.detail.subtotalShort')} {formatJPY(it.lineTotal)}
                              </Text>
                            </View>
                            <MerunoDisclosureIndicator
                              kind="crossEntity"
                              pressed={pressed}
                            />
                          </>
                        )}
                      </Pressable>
                    ) : (
                      <View style={styles.itemProductLink}>
                        <CategoryIdentityIcon
                          category={it.category ?? 'uncategorized'}
                          size={30}
                        />
                        <View style={styles.itemText}>
                          <Text style={styles.itemName}>{it.name}</Text>
                          <Text style={styles.itemMeta}>
                            {t('history.detail.quantityShort')} {it.quantity} · {t('history.detail.subtotalShort')} {formatJPY(it.lineTotal)}
                          </Text>
                        </View>
                      </View>
                    )}
                    <View style={styles.itemActions}>
                      {tag.visible ? (
                        <View style={styles.tag}>
                          <Text style={styles.tagText}>{tag.label}</Text>
                        </View>
                      ) : null}
                      <Pressable
                        onPress={() => openItemEditor(idx)}
                        accessibilityRole="button"
                        accessibilityLabel={t('history.detail.edit.title')}
                        hitSlop={6}
                        style={({ pressed }) => [
                          styles.editAction,
                          pressed && styles.editActionPressed,
                        ]}
                      >
                        <Text style={styles.editRowHint}>
                          {t('history.detail.editRowHint')}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </MerunoGroupedRow>
              );
            })}
          </MerunoGroupedList>
        ) : (
          <Text style={{ color: UI_COLORS.textSecondary }}>{t('history.detail.noItems')}</Text>
        )}

        <View style={{ height: 22 }} />

        {/* Dev-only: structured analysis outputs viewer */}
        {__DEV__ && (
          <>
            <Text style={styles.h2}>Dev: analysis outputs</Text>
            <View style={styles.summaryCard}>
              <Text style={{ color: UI_COLORS.textSecondary, fontSize: 12, marginBottom: 8 }}>
                analysis_level: {String(analysisOutputs?.analysis_level ?? 'n/a')}
              </Text>
              <Text selectable style={{ fontSize: 12, color: '#333' }}>
                {JSON.stringify(analysisOutputs?.analysis_outputs_v1 ?? null, null, 2)}
              </Text>
            </View>
          </>
        )}

        <Pressable
          style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]}
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel={t('history.detail.deleteRecord')}
        >
          <Text style={styles.deleteText}>{t('history.detail.deleteRecord')}</Text>
        </Pressable>
      </ScrollView>
      </View>

      {/* ===== 商品编辑 Modal ===== */}
      <Modal
        visible={itemEditOpen}
        animationType="slide"
        onRequestClose={closeItemEditor}
        presentationStyle="pageSheet"
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Pressable onPress={closeItemEditor} disabled={savingItem}>
              <Text style={[styles.modalHeaderBtn, savingItem && { opacity: 0.5 }]}>
                {t('history.detail.edit.cancel')}
              </Text>
            </Pressable>

            <Text style={styles.modalTitle}>{t('history.detail.edit.title')}</Text>

            <Pressable onPress={onSaveItemEdit} disabled={savingItem}>
              <Text style={[styles.modalHeaderBtn, savingItem && { opacity: 0.5 }]}>
                {savingItem ? t('history.detail.edit.saving') : t('history.detail.edit.save')}
              </Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody}>
            {editingItemIndex >= 0 && editingItemIndex < displayItems.length && (
              <>
                <Text style={styles.label}>{t('history.detail.edit.name')}</Text>
                <Text style={[styles.input, { color: UI_COLORS.textSecondary }]}>
                  {displayItems[editingItemIndex].name}
                </Text>

                <View style={{ height: 14 }} />

                <Text style={styles.label}>{t('history.detail.edit.category')}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                  {categoryOptions.map((cat) => (
                    <Pressable
                      key={cat}
                      onPress={() => setDraftCategory(cat)}
                      disabled={savingItem}
                    >
                      <View
                        style={[
                          styles.categoryOption,
                          draftCategory === cat && styles.categoryOptionSelected,
                        ]}
                      >
                        <Text
                          style={[
                            styles.categoryOptionText,
                            draftCategory === cat && styles.categoryOptionTextSelected,
                          ]}
                        >
                          {getCategoryLabel(cat)}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>

                <View style={{ height: 14 }} />

                <Text style={styles.label}>{t('history.detail.edit.quantity')}</Text>
                <TextInput
                  value={draftQuantity}
                  onChangeText={setDraftQuantity}
                  placeholder={t('history.detail.edit.quantityPlaceholder')}
                  keyboardType="numeric"
                  style={styles.input}
                  editable={!savingItem}
                />

                <View style={{ height: 14 }} />

                <Text style={styles.label}>{t('history.detail.edit.subtotal')}</Text>
                <TextInput
                  value={draftLineTotal}
                  onChangeText={setDraftLineTotal}
                  placeholder={t('history.detail.edit.subtotalPlaceholder')}
                  keyboardType="numeric"
                  style={styles.input}
                  editable={!savingItem}
                />
                <Text style={styles.hint}>
                  {t('history.detail.edit.unitNote')}
                </Text>
              </>
            )}

            <View style={{ height: 30 }} />
          </ScrollView>
        </View>
      </Modal>

    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  backButton: {
    minHeight: UI_LAYOUT.controlMinHeight,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: 0,
    alignSelf: 'center',
  },
  backText: {
    fontSize: 16,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
  },
  navigationHeader: {
    height: UI_LAYOUT.controlMinHeight,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    flexDirection: 'row',
    alignItems: 'center',
  },
  navigationTitle: {
    flex: 1,
    color: UI_COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  navigationSpacer: {
    width: 44,
  },
  center: {
    paddingTop: 80,
    alignItems: 'center',
  },
  container: {
    paddingTop: 8,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingBottom: 40,
  },
  merchant: {
    fontSize: 23,
    lineHeight: 29,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
  },
  date: {
    marginTop: 3,
    fontSize: 13,
    color: UI_COLORS.textSecondary,
  },
  total: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '900',
    color: UI_COLORS.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  tax: {
    flexShrink: 1,
    fontSize: 13,
    color: UI_COLORS.textSecondary,
    textAlign: 'right',
  },
  h2: {
    fontSize: 18,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
    marginTop: 26,
    marginBottom: 12,
  },
  summaryCard: {
    backgroundColor: UI_COLORS.surface,
    borderRadius: UI_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    paddingVertical: 5,
    paddingHorizontal: 16,
  },
  emptyGroupedRow: {
    minHeight: 64,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  summaryLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  summaryLeft: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
  },
  summaryRight: {
    fontSize: 15,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  summaryPercent: {
    width: 38,
    fontSize: 12,
    fontWeight: '700',
    color: UI_COLORS.textSecondary,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  categoryTrack: {
    height: 5,
    marginTop: 8,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  categoryFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: UI_COLORS.accent,
  },
  itemRow: {
    gap: 8,
  },
  itemProductLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: UI_LAYOUT.controlMinHeight,
    marginHorizontal: -6,
    paddingHorizontal: 6,
    borderRadius: UI_RADIUS.control,
  },
  itemProductLinkPressed: {
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  itemText: {
    flex: 1,
    minWidth: 0,
  },
  itemName: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600',
    marginBottom: 4,
    color: UI_COLORS.textPrimary,
  },
  itemMeta: {
    fontSize: 14,
    color: UI_COLORS.textSecondary,
  },
  itemActions: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  editAction: {
    minWidth: 44,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: UI_RADIUS.control,
  },
  editActionPressed: {
    backgroundColor: UI_COLORS.accentSoft,
  },
  editRowHint: {
    fontSize: 13,
    fontWeight: '600',
    color: UI_COLORS.accent,
  },
  tag: {
    alignSelf: 'center',
    backgroundColor: UI_COLORS.surfaceMuted,
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: 999,
  },
  tagText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
  },
  primaryBtn: {
    backgroundColor: UI_COLORS.accent,
    paddingVertical: 14,
    borderRadius: UI_RADIUS.card,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: UI_COLORS.background,
    fontSize: 16,
    fontWeight: '800',
  },
  deleteBtn: {
    marginTop: 12,
    minHeight: UI_LAYOUT.controlMinHeight,
    paddingVertical: 12,
    borderRadius: UI_RADIUS.control,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e8a8a8',
    backgroundColor: '#fffafa',
  },
  deleteText: {
    color: UI_COLORS.destructive,
    fontSize: 15,
    fontWeight: '800',
  },

  // ===== Modal styles =====
  modalContainer: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  modalHeader: {
    paddingTop: 16,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e6e6e6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalHeaderBtn: {
    fontSize: 16,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '900',
  },
  modalBody: {
    padding: 16,
    paddingBottom: 30,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: UI_COLORS.textSecondary,
    marginBottom: 6,
    marginTop: 10,
  },
  input: {
    backgroundColor: UI_COLORS.surface,
    borderRadius: UI_RADIUS.control,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  hint: {
    marginTop: 6,
    fontSize: 12,
    color: UI_COLORS.textMuted,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  h3: {
    fontSize: 18,
    fontWeight: '900',
  },
  addBtn: {
    fontSize: 14,
    fontWeight: '900',
    color: UI_COLORS.textPrimary,
  },
  editCard: {
    marginTop: 14,
    padding: 12,
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
  },
  editCardTitle: {
    fontSize: 14,
    fontWeight: '900',
  },
  removeBtn: {
    fontSize: 14,
    fontWeight: '900',
    color: UI_COLORS.destructive,
  },
  grid2: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  totalBox: {
    marginTop: 18,
    padding: 14,
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  totalLabel: {
    color: UI_COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 1,
  },
  totalValue: {
    fontSize: 22,
    fontWeight: '900',
  },
  receiptHero: {
    backgroundColor: UI_COLORS.surface,
    borderRadius: UI_RADIUS.hero,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    overflow: 'hidden',
  },
  receiptHeroBody: {
    flex: 1,
    paddingTop: 15,
    paddingHorizontal: 16,
  },
  merchantSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  merchantSummaryText: {
    flex: 1,
    minWidth: 0,
  },
  totalRow: {
    marginTop: 18,
    marginHorizontal: -16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI_COLORS.borderSubtle,
    backgroundColor: UI_COLORS.surfaceMuted,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 16,
  },
  editBtn: {
    paddingVertical: 8,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    borderRadius: 8,
    backgroundColor: UI_COLORS.textPrimary,
    alignSelf: 'flex-start',
  },
  editBtnText: {
    color: UI_COLORS.background,
    fontSize: 14,
    fontWeight: '800',
  },
  overrideHint: {
    fontSize: 12,
    color: UI_COLORS.textMuted,
    marginTop: 4,
    marginBottom: 6,
  },
  overrideHintSmall: {
    fontSize: 11,
    color: UI_COLORS.textMuted,
    marginLeft: 6,
  },
  categoryTag: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#eee',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    marginTop: 8,
    marginBottom: 8,
  },
  categoryTagText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
  },
  noteBox: {
    marginTop: 12,
    marginBottom: 8,
    padding: 12,
    backgroundColor: '#f6f6f6',
    borderRadius: UI_RADIUS.control,
  },
  noteLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: UI_COLORS.textSecondary,
    marginBottom: 4,
  },
  noteText: {
    fontSize: 15,
    color: '#333',
    lineHeight: 22,
  },
  textArea: {
    minHeight: 100,
    paddingTop: 10,
  },
  categoryOption: {
    paddingVertical: 8,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    borderRadius: 20,
    backgroundColor: UI_COLORS.surface,
    borderWidth: 1,
    borderColor: UI_COLORS.border,
  },
  categoryOptionSelected: {
    backgroundColor: UI_COLORS.textPrimary,
    borderColor: UI_COLORS.textPrimary,
  },
  categoryOptionText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
  },
  categoryOptionTextSelected: {
    color: UI_COLORS.background,
  },
});
