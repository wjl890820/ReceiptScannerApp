// app/(tabs)/history/[id].tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import {
  deleteReceipt,
  getReceipt,
  updateReceipt,
  type ReceiptRow,
} from '@/lib/db';
import { formatDate } from '@/lib/formatDate';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import { learnFromUserEdit } from '@/lib/receiptEnricher';
import { upsertProductDictionary } from '@/lib/productDictionary';
import { upsertProductNameAlias } from '@/lib/productAlias';
import { PRODUCT_CATEGORIES, normalizeProductCategory, type ProductCategory } from '@/lib/productCategory';
import { getCategoryColor, getCategoryLabel, getItemTagDisplay } from '@/lib/categoryPalette';
import { normalizeReceiptItemName } from '@/lib/productNormalizer';
import { mapLegacyCategoryToV1, buildAnalysisTags } from '@/lib/categoryTaxonomyV1';
import { applyProductIdentityToItem } from '@/lib/receiptItemIdentity';

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

/** Amount for summary: line_total / lineTotal first, else unit * qty */
function itemLineAmountForSummary(it: any): number {
  const lt = toNum(it.lineTotal ?? it.line_total, 0);
  if (lt > 0) return round0(lt);
  const qRaw = toNum(it.quantity, 0);
  const q = qRaw > 0 ? qRaw : 1;
  const up = toNum(it.unitPrice ?? it.unit_price, 0);
  return up > 0 ? round0(up * q) : 0;
}

/**
 * 分类汇总：直接用统一的 normalizeProductCategory 归一（兼容新旧 enum、OCR categoryKey）。
 * 只要有商品行就会产出分桶（含"待分类"），仅当完全没有商品行时上层才显示"未找到分类信息"。
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
    const cat = normalizeProductCategory(rawCat, typeof it.name === 'string' ? it.name : undefined);
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
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState<ReceiptRow | null>(null);

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
    receipt?.merchant_normalized ||
    receipt?.merchant_raw ||
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
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const row = await getReceipt(String(id));
      setReceipt(row ?? null);
    } catch (e: any) {
      console.error(e);
      Alert.alert(t('history.errors.loadTitle'), t('history.detail.loadMessage'));
      setReceipt(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const openItemEditor = (index: number) => {
    if (index < 0 || index >= displayItems.length) return;
    const item = displayItems[index];
    setEditingItemIndex(index);
    setDraftCategory(normalizeProductCategory(item.category, item.name));
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
    updatedItems[editingItemIndex] = applyProductIdentityToItem({
      ...existingItem,
      quantity: round0(quantity),
      lineTotal: round0(lineTotal),
      category: finalCategory,
    }, {
      finalName: existingItem.name,
      finalCategory,
      merchantName: receipt.merchant_raw,
      classificationBrand: (existingItem as any).brand,
      useExistingClassificationEvidence: true,
    });

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
              await deleteReceipt(receipt.id);
              Alert.alert(t('history.detail.deletedTitle'));
              router.back();
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
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10 }}>{t('history.detail.loading')}</Text>
      </View>
    );
  }

  if (!receipt) {
    return (
      <View style={styles.center}>
        <Text>{t('history.detail.notFound')}</Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.merchant}>{merchant}</Text>
            <Text style={styles.date}>
              {formatDate(receipt.transaction_at || receipt.created_at)}
            </Text>
          </View>
        </View>

        <Text style={styles.total}>
          {formatJPY(displayTotal)}
        </Text>
        {receipt.user_edited === 1 && receipt.user_items_json && (
          <Text style={styles.overrideHint}>
            {t('history.detail.editedHint')}
          </Text>
        )}
        <Text style={styles.tax}>{t('history.detail.taxLabel')} {receipt.tax}</Text>

        {/* 分类汇总 */}
        <Text style={styles.h2}>{t('history.detail.categorySummaryTitle')}</Text>
        <View style={styles.summaryCard}>
          {categorySummary.length === 0 ? (
            <View style={{ paddingVertical: 10 }}>
              <Text style={{ color: '#666' }}>{t('history.detail.noCategoryInfo')}</Text>
            </View>
          ) : (
            categorySummary.map((x) => {
              const color = getCategoryColor(x.category);
              return (
                <View key={x.category} style={styles.summaryRow}>
                  <View style={[styles.categoryColorBar, { backgroundColor: color }]} />
                  <Text style={styles.summaryLeft}>
                    {getCategoryLabel(x.category)}
                  </Text>
                  <Text style={styles.summaryRight}>
                    {formatJPY(x.amount)}
                  </Text>
                </View>
              );
            })
          )}
        </View>

        {/* 商品明细 */}
        <Text style={styles.h2}>{t('history.detail.itemsTitle')}</Text>

        {displayItems.length > 0 ? (
          <View style={styles.itemsWrap}>
            {displayItems.map((it, idx) => (
              <Pressable
                key={`${it.name}-${idx}`}
                style={({ pressed }) => [
                  styles.itemRow,
                  pressed && { backgroundColor: '#f5f5f5' },
                ]}
                onPress={() => openItemEditor(idx)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{it.name}</Text>
                  <Text style={styles.itemMeta}>
                    {t('history.detail.quantityShort')} {it.quantity} · {t('history.detail.subtotalShort')} {formatJPY(it.lineTotal)}
                  </Text>
                </View>
                {(() => {
                  const tag = getItemTagDisplay(it as any);
                  if (!tag.visible) return null;
                  return (
                    <View style={styles.tag}>
                      <Text style={styles.tagText}>{tag.label}</Text>
                    </View>
                  );
                })()}
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={{ color: '#666' }}>{t('history.detail.noItems')}</Text>
        )}

        <View style={{ height: 22 }} />

        {/* Dev-only: structured analysis outputs viewer */}
        {__DEV__ && (
          <>
            <Text style={styles.h2}>Dev: analysis outputs</Text>
            <View style={styles.summaryCard}>
              <Text style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>
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
        >
          <Text style={styles.deleteText}>{t('history.detail.deleteRecord')}</Text>
        </Pressable>
      </ScrollView>

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
                <Text style={[styles.input, { color: '#666' }]}>
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
  center: {
    paddingTop: 120,
    alignItems: 'center',
  },
  container: {
    paddingTop: 70,
    paddingHorizontal: 18,
    paddingBottom: 40,
  },
  merchant: {
    fontSize: 34,
    fontWeight: '800',
    marginBottom: 6,
  },
  date: {
    fontSize: 16,
    color: '#666',
    marginBottom: 18,
  },
  total: {
    fontSize: 40,
    fontWeight: '900',
    marginBottom: 6,
  },
  tax: {
    fontSize: 18,
    color: '#666',
    marginBottom: 18,
  },
  h2: {
    fontSize: 22,
    fontWeight: '800',
    marginTop: 10,
    marginBottom: 10,
  },
  summaryCard: {
    backgroundColor: '#f6f6f6',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: 8,
  },
  categoryColorBar: {
    width: 4,
    height: 20,
    borderRadius: 2,
  },
  summaryLeft: {
    fontSize: 16,
    fontWeight: '700',
  },
  summaryRight: {
    fontSize: 16,
    fontWeight: '800',
  },
  itemsWrap: {
    marginTop: 4,
  },
  itemRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e3e3e3',
  },
  itemName: {
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 4,
  },
  itemMeta: {
    fontSize: 14,
    color: '#666',
  },
  tag: {
    alignSelf: 'center',
    backgroundColor: '#eee',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  tagText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
  },
  primaryBtn: {
    backgroundColor: '#111',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  deleteBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  deleteText: {
    color: '#d33',
    fontSize: 18,
    fontWeight: '800',
  },

  // ===== Modal styles =====
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  modalHeader: {
    paddingTop: 16,
    paddingHorizontal: 16,
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
    color: '#111',
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
    color: '#666',
    marginBottom: 6,
    marginTop: 10,
  },
  input: {
    backgroundColor: '#f3f3f3',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  hint: {
    marginTop: 6,
    fontSize: 12,
    color: '#888',
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
    color: '#111',
  },
  editCard: {
    marginTop: 14,
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#fafafa',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e8e8e8',
  },
  editCardTitle: {
    fontSize: 14,
    fontWeight: '900',
  },
  removeBtn: {
    fontSize: 14,
    fontWeight: '900',
    color: '#d33',
  },
  grid2: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  totalBox: {
    marginTop: 18,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#f6f6f6',
  },
  totalLabel: {
    color: '#666',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  totalValue: {
    fontSize: 22,
    fontWeight: '900',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  editBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#111',
    alignSelf: 'flex-start',
  },
  editBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  overrideHint: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
    marginBottom: 6,
  },
  overrideHintSmall: {
    fontSize: 11,
    color: '#888',
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
    borderRadius: 10,
  },
  noteLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#666',
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
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: '#f3f3f3',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  categoryOptionSelected: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  categoryOptionText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
  },
  categoryOptionTextSelected: {
    color: '#fff',
  },
});
