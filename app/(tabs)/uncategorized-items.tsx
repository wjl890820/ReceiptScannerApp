// Bulk-fill product_dictionary for normalized_name not yet in the dictionary.

import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getCategoryLabel } from '@/lib/categoryPalette';
import { buildAnalysisTags, mapLegacyCategoryToV1 } from '@/lib/categoryTaxonomyV1';
import {
  getMissingInProductDictionaryTop100,
  type MissingDictionaryCandidate,
} from '@/lib/missingDictionaryCandidates';
import { upsertProductDictionary } from '@/lib/productDictionary';
import { reclassifyReceiptsMissingCategories } from '@/lib/reclassifyReceipts';

/** 新一级分类 key → 中文说明（写入 DB 仍经 mapLegacyCategoryToV1，已兼容新 enum） */
const CATEGORY_PICKER_OPTIONS: Array<{ legacyKey: string; labelZh: string }> = [
  { legacyKey: 'food_ingredients', labelZh: '食材' },
  { legacyKey: 'ready_to_eat', labelZh: '即食餐' },
  { legacyKey: 'snacks_drinks', labelZh: '饮料零食' },
  { legacyKey: 'household', labelZh: '日用消耗' },
  { legacyKey: 'personal_care', labelZh: '个人护理' },
  { legacyKey: 'pet_care', labelZh: '宠物用品' },
  { legacyKey: 'other', labelZh: '其他' },
];

export default function UncategorizedItemsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<MissingDictionaryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [reclassifyBusy, setReclassifyBusy] = useState(false);
  const [pickerFor, setPickerFor] = useState<MissingDictionaryCandidate | null>(null);
  const [upserting, setUpserting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMissingInProductDictionaryTop100(1500, 100);
      setRows(data);
    } catch (e: any) {
      Alert.alert('加载失败', e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onPickCategory = async (legacyKey: string) => {
    if (!pickerFor || upserting) return;
    const name = pickerFor.normalized_name;
    setUpserting(true);
    try {
      const v1 = mapLegacyCategoryToV1(legacyKey);
      await upsertProductDictionary({
        normalized_name: name,
        canonical_name: name,
        category_main: String(v1.main),
        category_sub: v1.sub ? String(v1.sub) : null,
        analysis_tags: buildAnalysisTags(v1),
        source_type: 'manual',
        confidence: 1,
      });
      setPickerFor(null);
      setRows((prev) => prev.filter((r) => r.normalized_name !== name));
    } catch (e: any) {
      Alert.alert('保存失败', e?.message || String(e));
    } finally {
      setUpserting(false);
    }
  };

  const onReclassifyAll = async () => {
    if (reclassifyBusy) return;
    setReclassifyBusy(true);
    try {
      const s = await reclassifyReceiptsMissingCategories(500);
      Alert.alert(
        'Reclassify all receipts 完成',
        `updated=${s.touched}\nuserEditedSkipped=${s.skippedUserEdited}\nnoItemsSkipped=${s.skippedNoItems}\nalreadyOkSkipped=${s.skippedAlreadyCategorized}\nfailed=${s.failed}`
      );
    } catch (e: any) {
      Alert.alert('重分类失败', e?.message || String(e));
    } finally {
      setReclassifyBusy(false);
    }
  };

  const renderRow = ({ item }: { item: MissingDictionaryCandidate }) => {
    const catLabel = item.receiptCategoryLegacy
      ? getCategoryLabel(item.receiptCategoryLegacy)
      : '未分类';
    return (
      <Pressable
        style={styles.row}
        onPress={() => setPickerFor(item)}
        disabled={upserting}
      >
        <Text style={styles.rowName} numberOfLines={3}>
          {item.normalized_name}
        </Text>
        <Text style={styles.rowMeta}>
          <Text style={styles.rowCount}>({item.count})</Text>
          {'  '}
          <Text style={styles.rowCat}>{catLabel}</Text>
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backText}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>未分类商品</Text>
        <Text style={styles.subtitle}>Missing in product_dictionary · Top 100</Text>
      </View>

      <Pressable
        style={[styles.reclassBtn, reclassifyBusy && styles.btnDisabled]}
        onPress={onReclassifyAll}
        disabled={reclassifyBusy}
      >
        {reclassifyBusy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.reclassBtnText}>Reclassify all receipts</Text>
        )}
      </Pressable>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(it) => it.normalized_name}
          renderItem={renderRow}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.empty}>暂无待补全商品（或已全部加入词典）</Text>
          }
        />
      )}

      <Modal
        visible={pickerFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => !upserting && setPickerFor(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => !upserting && setPickerFor(null)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle} numberOfLines={2}>
              选择分类
              {pickerFor ? `\n${pickerFor.normalized_name}` : ''}
            </Text>
            {upserting ? (
              <ActivityIndicator style={styles.modalSpinner} />
            ) : (
              CATEGORY_PICKER_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.legacyKey}
                  style={styles.modalRow}
                  onPress={() => onPickCategory(opt.legacyKey)}
                >
                  <Text style={styles.modalRowText}>{opt.labelZh}</Text>
                  <Text style={styles.modalRowHint}>{opt.legacyKey}</Text>
                </Pressable>
              ))
            )}
            <Pressable
              style={styles.modalCancel}
              onPress={() => !upserting && setPickerFor(null)}
            >
              <Text style={styles.modalCancelText}>取消</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 56,
  },
  header: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  backBtn: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  backText: {
    fontSize: 16,
    color: '#007AFF',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
  },
  subtitle: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
  },
  reclassBtn: {
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: '#111',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  reclassBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#f8f8f8',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e8e8e8',
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111',
    marginBottom: 6,
  },
  rowMeta: {
    fontSize: 13,
    color: '#666',
  },
  rowCount: {
    color: '#666',
  },
  rowCat: {
    color: '#333',
    fontWeight: '500',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  empty: {
    textAlign: 'center',
    color: '#888',
    marginTop: 40,
    paddingHorizontal: 24,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 4,
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingBottom: 12,
    color: '#111',
  },
  modalSpinner: {
    padding: 24,
  },
  modalRow: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  modalRowText: {
    fontSize: 16,
    color: '#111',
  },
  modalRowHint: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
  },
  modalCancel: {
    marginTop: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 16,
    color: '#007AFF',
  },
});
