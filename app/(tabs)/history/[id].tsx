// app/(tabs)/history/[id].tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
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
import { learnFromUserEdit } from '@/lib/receiptEnricher';
import { GROCERY_CATEGORIES, ALL_CATEGORIES, type Category } from '@/lib/categories';
import { t } from '@/lib/i18n';
import { getCategoryColor, getCategoryLabel } from '@/lib/categoryPalette';

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

function formatDate(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

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

function buildCategorySummary(analysis: ReceiptAnalysis | { items: ReceiptItem[] } | null) {
  const map = new Map<string, number>();
  if (!analysis?.items?.length) return [];

  for (const it of analysis.items) {
    const cat = (it.category && String(it.category).trim()) || 'Other';
    const amt = toNum(it.lineTotal, 0);
    map.set(cat, (map.get(cat) ?? 0) + amt);
  }

  const arr = Array.from(map.entries()).map(([category, amount]) => ({
    category,
    amount,
  }));

  arr.sort((a, b) => b.amount - a.amount);
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
  const categoryOptions = [...GROCERY_CATEGORIES, 'uncategorized'] as Category[];

  const analysis = useMemo(() => {
    if (!receipt) return null;
    return safeParseAnalysis(receipt.analysis_json);
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

  const categorySummary = useMemo(
    () => buildCategorySummary(displayAnalysis),
    [displayAnalysis]
  );

  const merchant =
    receipt?.merchant_normalized ||
    receipt?.merchant_raw ||
    analysis?.merchant ||
    '未知商店';

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
      Alert.alert('读取失败', e?.message ?? '无法读取该记录');
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
    setDraftCategory(item.category || 'Other');
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
      Alert.alert('输入错误', '数量必须大于等于 1');
      return;
    }

    const lineTotal = toNum(draftLineTotal.trim(), 0);
    if (lineTotal <= 0) {
      Alert.alert('输入错误', '小计必须大于 0');
      return;
    }

    // 更新商品列表
    const updatedItems = [...displayItems];
    updatedItems[editingItemIndex] = {
      ...updatedItems[editingItemIndex],
      quantity: round0(quantity),
      lineTotal: round0(lineTotal),
      category: draftCategory.trim() || 'Other',
    };

    try {
      setSavingItem(true);
      
      // 学习用户编辑的分类
      const editedItem = updatedItems[editingItemIndex];
      if (editedItem && editedItem.name && editedItem.category) {
        await learnFromUserEdit(editedItem.name, editedItem.category);
      }

      await updateReceipt({
        id: receipt.id,
        user_edited: 1,
        user_items_json: JSON.stringify(updatedItems),
      });

      setItemEditOpen(false);
      await load();
      Alert.alert('已保存');
    } catch (e: any) {
      console.error(e);
      Alert.alert('保存失败', e?.message ?? '请重试');
    } finally {
      setSavingItem(false);
    }
  };

  const onDelete = async () => {
    if (!receipt) return;

    Alert.alert('确认删除', '删除后无法恢复，确定要删除吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteReceipt(receipt.id);
            Alert.alert('已删除');
            router.back();
          } catch (e: any) {
            console.error(e);
            Alert.alert('删除失败', e?.message ?? '请重试');
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10 }}>加载中…</Text>
      </View>
    );
  }

  if (!receipt) {
    return (
      <View style={styles.center}>
        <Text>未找到该记录</Text>
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
          {displayTotal} {currency}
        </Text>
        {receipt.user_edited === 1 && receipt.user_items_json && (
          <Text style={styles.overrideHint}>
            （已手动编辑商品）
          </Text>
        )}
        <Text style={styles.tax}>税 {receipt.tax}</Text>

        {receipt.image_uri ? (
          <View style={styles.imageWrap}>
            <Image source={{ uri: receipt.image_uri }} style={styles.image} />
          </View>
        ) : null}

        {/* 分类汇总 */}
        <Text style={styles.h2}>分类汇总：</Text>
        <View style={styles.summaryCard}>
          {categorySummary.length === 0 ? (
            <View style={{ paddingVertical: 10 }}>
              <Text style={{ color: '#666' }}>暂无分类信息</Text>
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
                    {round0(x.amount)} {currency}
                  </Text>
                </View>
              );
            })
          )}
        </View>

        {/* 商品明细 */}
        <Text style={styles.h2}>商品明细：</Text>

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
                    数量 {it.quantity} · 小计 {it.lineTotal} {currency}
                  </Text>
                </View>
                <View style={styles.tag}>
                  <Text style={styles.tagText}>
                    {it.category ? t(`category.${it.category}`) : t('category.uncategorized')}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={{ color: '#666' }}>无商品明细</Text>
        )}

        <View style={{ height: 22 }} />

        <Pressable
          style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]}
          onPress={onDelete}
        >
          <Text style={styles.deleteText}>删除这条记录</Text>
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
                取消
              </Text>
            </Pressable>

            <Text style={styles.modalTitle}>编辑商品</Text>

            <Pressable onPress={onSaveItemEdit} disabled={savingItem}>
              <Text style={[styles.modalHeaderBtn, savingItem && { opacity: 0.5 }]}>
                {savingItem ? '保存中…' : '保存'}
              </Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody}>
            {editingItemIndex >= 0 && editingItemIndex < displayItems.length && (
              <>
                <Text style={styles.label}>商品名称</Text>
                <Text style={[styles.input, { color: '#666' }]}>
                  {displayItems[editingItemIndex].name}
                </Text>

                <View style={{ height: 14 }} />

                <Text style={styles.label}>分类</Text>
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

                <Text style={styles.label}>数量</Text>
                <TextInput
                  value={draftQuantity}
                  onChangeText={setDraftQuantity}
                  placeholder="请输入数量"
                  keyboardType="numeric"
                  style={styles.input}
                  editable={!savingItem}
                />

                <View style={{ height: 14 }} />

                <Text style={styles.label}>小计</Text>
                <TextInput
                  value={draftLineTotal}
                  onChangeText={setDraftLineTotal}
                  placeholder="请输入小计"
                  keyboardType="numeric"
                  style={styles.input}
                  editable={!savingItem}
                />
                <Text style={styles.hint}>
                  单位：{currency}
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
  imageWrap: {
    backgroundColor: '#f3f3f3',
    borderRadius: 16,
    padding: 10,
    alignItems: 'center',
    marginBottom: 18,
  },
  image: {
    width: '100%',
    height: 280,
    resizeMode: 'contain',
    borderRadius: 12,
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
