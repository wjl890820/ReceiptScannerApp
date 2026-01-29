import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { deleteReceipts, listReceiptsForList, type ReceiptListRow } from '@/lib/db';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import { getCategoryLabel } from '@/lib/categoryPalette';
import { isGroceryCategory, isExcludedFromAnalytics } from '@/lib/categories';

function formatDate(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function safeNumber(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从 ReceiptRow.analysis_json 里提取：仅 ok + 有效 grocery 分类的 TopN，用于列表预览
 * 不包含 non_grocery / uncategorized / failed；标签统一走 getCategoryLabel
 */
function buildTopCategories(
  analysisJson: string | null | undefined,
  topN = 2
): string[] {
  if (!analysisJson) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(analysisJson);
  } catch {
    return [];
  }

  const items: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  if (items.length === 0) return [];

  const map = new Map<string, number>();

  for (const it of items) {
    const key = String(it?.category ?? it?.categoryKey ?? '').trim();
    if (!key || key === 'non_grocery' || isExcludedFromAnalytics(key)) continue;
    const status = (it as any).classification_status as string | undefined;
    if (status !== undefined && status !== 'ok') continue;
    if (!isGroceryCategory(key)) continue;

    const lineTotal = safeNumber(it?.lineTotal);
    const quantity = safeNumber(it?.quantity);
    const unitPrice = safeNumber(it?.unitPrice);
    const amount = lineTotal > 0 ? lineTotal : quantity * unitPrice;
    map.set(key, (map.get(key) ?? 0) + safeNumber(amount));
  }

  const arr = Array.from(map.entries())
    .map(([key, amount]) => ({ key, label: getCategoryLabel(key), amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);

  return arr.map((x) => `${x.label} ${Math.round(x.amount)}`);
}

export default function HistoryScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<ReceiptListRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listReceiptsForList(200);
      setRows(data);
    } catch (e: any) {
      console.error(e);
      Alert.alert(t('history.errors.loadTitle'), e?.message ?? t('history.errors.loadMessage'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    React.useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

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
              Alert.alert(t('history.batchDelete.deleteFailed'), e?.message ?? '');
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

  const selectModeBarVisible = selectMode && rows.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>历史记录</Text>
          <Text style={styles.subtitle}>点击任意一条进入详情页</Text>
        </View>
        <Pressable
          onPress={toggleSelectMode}
          disabled={deleting}
          style={({ pressed }) => [
            styles.headerBtn,
            pressed && { opacity: 0.7 },
            deleting && { opacity: 0.5 },
          ]}
        >
          <Text style={styles.headerBtnText}>
            {selectMode ? t('history.batchDelete.cancel') : t('history.batchDelete.select')}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={selectModeBarVisible ? styles.listContentWithBar : undefined}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={
          <View style={{ paddingTop: 30 }}>
            <Text style={{ color: '#666' }}>
              暂无记录。请先在 Home 里识别并保存。
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const topCats = buildTopCategories(item.analysis_json, 2);
          const checked = selectedIds.has(item.id);

          return (
            <Pressable
              onPress={() => onItemPress(item)}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
            >
              <View style={styles.cardInner}>
                {selectMode && (
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked ? <Text style={styles.checkmark}>✓</Text> : null}
                  </View>
                )}
                <View style={styles.cardBody}>
                  <View style={styles.row}>
                    <Text style={styles.merchant}>
                      {item.merchant_normalized || item.merchant_raw || t('common.unknownMerchant')}
                    </Text>
                    <Text style={styles.total}>{formatJPY(item.total)}</Text>
                  </View>
                  <Text style={styles.meta}>
                    {formatDate(item.transaction_at || item.created_at)} · 税 {item.tax}
                  </Text>
                  {topCats.length > 0 ? (
                    <Text style={styles.cats}>{topCats.join(' · ')}</Text>
                  ) : (
                    <Text style={styles.catsMuted}>未找到分类信息</Text>
                  )}
                </View>
              </View>
            </Pressable>
          );
        }}
      />

      {selectModeBarVisible && (
        <View style={styles.bottomBar}>
          <Pressable
            onPress={selectAll}
            disabled={deleting}
            style={({ pressed }) => [styles.bottomBarBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.bottomBarBtnText}>
              {t('history.batchDelete.selectAll')}
            </Text>
          </Pressable>
          <Pressable
            onPress={onDeleteSelected}
            disabled={deleting || selectedIds.size === 0}
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
    paddingTop: 80,
    paddingHorizontal: 18,
    paddingBottom: 20,
    flex: 1,
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
  headerBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  headerBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  list: {
    flex: 1,
  },
  listContentWithBar: {
    paddingBottom: 70,
  },
  sep: {
    height: 10,
  },
  card: {
    backgroundColor: '#f3f3f3',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  cardInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
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
  merchant: {
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
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
  bottomBarBtnDanger: {},
  bottomBarBtnDangerText: {
    color: '#c00',
    fontWeight: '800',
  },
});
