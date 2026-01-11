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

import { listReceipts, type ReceiptRow } from '@/lib/db';

type CategoryKey =
  | 'fresh'
  | 'staple'
  | 'dairy_egg'
  | 'snack'
  | 'drink'
  | 'frozen_deli'
  | 'seasoning'
  | 'household'
  | 'alcohol'
  | 'other';

function categoryLabel(key?: string): string {
  switch (key as CategoryKey) {
    case 'fresh':
      return '生鲜';
    case 'staple':
      return '主食';
    case 'dairy_egg':
      return '乳制品/蛋';
    case 'snack':
      return '零食/甜品';
    case 'drink':
      return '饮料';
    case 'frozen_deli':
      return '冷冻/熟食';
    case 'seasoning':
      return '调味料';
    case 'household':
      return '日用品';
    case 'alcohol':
      return '酒类';
    case 'other':
      return '其它';
    default:
      return '未分类';
  }
}

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
 * 从 ReceiptRow.analysis_json 里提取：分类汇总 TopN
 * 返回示例：["生鲜 1215", "零食/甜品 1179"]
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
    const key = String(it?.categoryKey ?? 'uncategorized');
    const lineTotal = safeNumber(it?.lineTotal);
    const quantity = safeNumber(it?.quantity);
    const unitPrice = safeNumber(it?.unitPrice);

    const amount = lineTotal > 0 ? lineTotal : quantity * unitPrice;
    map.set(key, (map.get(key) ?? 0) + safeNumber(amount));
  }

  const arr = Array.from(map.entries())
    .map(([key, amount]) => ({
      key,
      label: key === 'uncategorized' ? '未分类' : categoryLabel(key),
      amount,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);

  return arr.map((x) => `${x.label} ${Math.round(x.amount)}`);
}

export default function HistoryScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listReceipts(200);
      setRows(data);
    } catch (e: any) {
      console.error(e);
      Alert.alert('读取失败', e?.message ?? '无法读取历史记录');
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

  return (
    <View style={styles.container}>
      <Text style={styles.title}>历史记录</Text>
      <Text style={styles.subtitle}>点击任意一条进入详情页</Text>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
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
          // 关键：这里用 analysis_json（下划线）
          const topCats = buildTopCategories(item.analysis_json, 2);

          return (
            <Pressable
              onPress={() => router.push(`/history/${item.id}`)}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
            >
              <View style={styles.row}>
                <Text style={styles.merchant}>
                  {item.merchant_normalized || item.merchant_raw || '未知商店'}
                </Text>
                <Text style={styles.total}>
                  {item.total} {item.currency}
                </Text>
              </View>

              <Text style={styles.meta}>
                {formatDate(item.created_at)} · 税 {item.tax}
              </Text>

              {topCats.length > 0 ? (
                <Text style={styles.cats}>{topCats.join(' · ')}</Text>
              ) : (
                <Text style={styles.catsMuted}>未找到分类信息</Text>
              )}
            </Pressable>
          );
        }}
      />
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
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 14,
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
});
