import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { listReceipts, saveReceipt } from '@/lib/db';
import { GROCERY_CATEGORIES, SPECIAL_CATEGORIES, type Category } from '@/lib/categories';
import { getCategoryLabel } from '@/lib/categoryPalette';
import { getCurrentLocale, t } from '@/lib/i18n';
import { tryShowNextEasterEgg } from '@/lib/homeEasterEggHelpers';
import { getDefaultReceiptSource } from '@/lib/receiptSourceSettings';
import { applyReviewCorrectionsToLearning } from '@/lib/receiptReviewLearning';
import { runPostSaveGrowthAnalysis } from '@/lib/postSaveGrowthAnalysis';
import { RECEIPT_REVIEW_ERROR_TAGS, isReceiptReviewErrorTag } from '@/lib/reviewErrorTags';
import {
  getScanReviewDraft,
  persistScanReviewDraftEditorState,
  removeScanReviewDraft,
  type ScanReviewEditorStateV1,
} from '@/lib/scanReviewDraftStore';
import { peekNextDraftId } from '@/lib/scanReviewQueue';
import { logger } from '@/lib/logger';
import { isDevToolsUnlocked } from '@/lib/devToolsAccess';

function toNum(v: string, fallback = 0): number {
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}

const categoryOptions = [...GROCERY_CATEGORIES, ...SPECIAL_CATEGORIES] as Category[];

let lineIdSeq = 0;
/** 生成稳定的本地行 id，作为 React key，避免使用数组 index */
function makeLineId(): string {
  lineIdSeq += 1;
  return `li_${Date.now().toString(36)}_${lineIdSeq.toString(36)}`;
}

type LineItem = {
  id: string;
  /** 对应 OCR snapshot.items 的索引；人工新增行为 null */
  sourceIndex: number | null;
  name: string;
  category: Category;
  quantity: number;
  lineTotal: number;
};

export default function ScanReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();

  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [totalStr, setTotalStr] = useState('');
  const [taxStr, setTaxStr] = useState('');
  const [currency, setCurrency] = useState('JPY');
  const [note, setNote] = useState('');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [errorTags, setErrorTags] = useState<Set<string>>(new Set());
  const [ocrText, setOcrText] = useState('');
  const [traceId, setTraceId] = useState('');
  const [imageUri, setImageUri] = useState('');
  const [snapshot, setSnapshot] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [categoryModalIndex, setCategoryModalIndex] = useState(-1);
  const [showDevTrace, setShowDevTrace] = useState(false);
  const persistPayloadRef = useRef<{ id: string; state: ScanReviewEditorStateV1 } | null>(null);
  const saveInFlightRef = useRef(false);

  useEffect(() => {
    let c = false;
    void isDevToolsUnlocked().then((on) => {
      if (!c) setShowDevTrace(on);
    });
    return () => {
      c = true;
    };
  }, []);

  const applySnapshotDefaults = useCallback((snap: any) => {
    setMerchant(typeof snap?.merchant === 'string' ? snap.merchant : '');
    setDateStr(typeof snap?.transactionDate === 'string' ? snap.transactionDate : '');
    setTotalStr(String(snap?.total ?? ''));
    setTaxStr(String(snap?.tax ?? ''));
    setCurrency(typeof snap?.currency === 'string' && snap.currency.trim() ? snap.currency : 'JPY');
    setNote('');
    setOcrText(typeof snap?.ocr_raw_text === 'string' ? snap.ocr_raw_text : '');
    const items = Array.isArray(snap?.items) ? snap.items : [];
    setLineItems(
      items.map((it: any, idx: number) => ({
        id: makeLineId(),
        sourceIndex: idx,
        name: typeof it?.name === 'string' ? it.name : '',
        category: (typeof it?.category === 'string' && categoryOptions.includes(it.category as Category)
          ? it.category
          : 'uncategorized') as Category,
        quantity: Number.isFinite(Number(it?.quantity)) ? Number(it.quantity) : 1,
        lineTotal: Number.isFinite(Number(it?.lineTotal ?? it?.line_total))
          ? Number(it.lineTotal ?? it.line_total)
          : 0,
      }))
    );
    setErrorTags(new Set());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = String(draftId || '');
      if (!id) {
        if (!cancelled) {
          setMissing(true);
          setLoading(false);
        }
        return;
      }
      if (!cancelled) {
        setMissing(false);
        setLoading(true);
      }
      const draft = await getScanReviewDraft(id);
      if (cancelled) return;
      if (!draft) {
        setMissing(true);
        setLoading(false);
        return;
      }
      const snap = draft.recognitionSnapshot as any;
      setSnapshot(snap);
      setImageUri(draft.imageUri);
      setTraceId(draft.traceId);

      const es = draft.editorState;
      // 兼容删除/新增行：不再要求 lineItems 长度与 snapshot 行数一致；
      // 仅要求 version 与数组结构正确即可恢复（含全部删空的空数组）。
      if (es?.version === 1 && Array.isArray(es.lineItems)) {
        setMerchant(typeof es.merchant === 'string' ? es.merchant : '');
        setDateStr(typeof es.dateStr === 'string' ? es.dateStr : '');
        setTotalStr(typeof es.totalStr === 'string' ? es.totalStr : String(snap?.total ?? ''));
        setTaxStr(typeof es.taxStr === 'string' ? es.taxStr : String(snap?.tax ?? ''));
        setCurrency(typeof es.currency === 'string' && es.currency.trim() ? es.currency : 'JPY');
        setNote(typeof es.note === 'string' ? es.note : '');
        setOcrText(typeof snap?.ocr_raw_text === 'string' ? snap.ocr_raw_text : '');
        setLineItems(
          es.lineItems.map((li, idx) => {
            // 旧草稿缺 sourceIndex：按数组下标补；显式 null 视为人工新增行。
            const rawSrc = (li as { sourceIndex?: number | null }).sourceIndex;
            const sourceIndex =
              typeof rawSrc === 'number' && Number.isInteger(rawSrc)
                ? rawSrc
                : rawSrc === null
                ? null
                : idx;
            const rawId = (li as { id?: string }).id;
            return {
              id: typeof rawId === 'string' && rawId ? rawId : makeLineId(),
              sourceIndex,
              name: typeof li.name === 'string' ? li.name : '',
              category: (typeof li.category === 'string' && categoryOptions.includes(li.category as Category)
                ? li.category
                : 'uncategorized') as Category,
              quantity: Number.isFinite(Number(li.quantity)) ? Number(li.quantity) : 1,
              lineTotal: Number.isFinite(Number(li.lineTotal)) ? Number(li.lineTotal) : 0,
            };
          })
        );
        setErrorTags(new Set((es.errorTags || []).filter(isReceiptReviewErrorTag)));
      } else {
        applySnapshotDefaults(snap);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [draftId, applySnapshotDefaults]);

  useEffect(() => {
    if (loading || missing || !draftId || !snapshot) {
      persistPayloadRef.current = null;
      return;
    }
    const id = String(draftId);
    const state: ScanReviewEditorStateV1 = {
      version: 1,
      merchant,
      dateStr,
      totalStr,
      taxStr,
      currency,
      note,
      lineItems: lineItems.map((li) => ({
        id: li.id,
        sourceIndex: li.sourceIndex,
        name: li.name,
        category: li.category,
        quantity: li.quantity,
        lineTotal: li.lineTotal,
      })),
      errorTags: Array.from(errorTags).filter(isReceiptReviewErrorTag),
    };
    persistPayloadRef.current = { id, state };
    const t = setTimeout(() => {
      void persistScanReviewDraftEditorState(id, state);
    }, 650);
    return () => clearTimeout(t);
  }, [
    loading,
    missing,
    draftId,
    snapshot,
    merchant,
    dateStr,
    totalStr,
    taxStr,
    currency,
    note,
    lineItems,
    errorTags,
  ]);

  useEffect(() => {
    return () => {
      const p = persistPayloadRef.current;
      if (p) void persistScanReviewDraftEditorState(p.id, p.state);
    };
  }, []);

  const toggleErrorTag = (tag: string) => {
    if (!isReceiptReviewErrorTag(tag)) return;
    setErrorTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const updateLine = (index: number, patch: Partial<LineItem>) => {
    setLineItems((rows) => {
      const next = [...rows];
      if (index < 0 || index >= next.length) return rows;
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const addLineItem = () => {
    if (saving) return;
    setLineItems((rows) => [
      ...rows,
      { id: makeLineId(), sourceIndex: null, name: '', category: 'uncategorized' as Category, quantity: 1, lineTotal: 0 },
    ]);
  };

  const removeLineItem = (index: number) => {
    if (saving) return;
    Alert.alert(t('scanReview.deleteItemTitle'), t('scanReview.deleteItemMessage'), [
      { text: t('home.scan.cancel'), style: 'cancel' },
      {
        text: t('scanReview.deleteItemConfirm'),
        style: 'destructive',
        onPress: () => {
          setLineItems((rows) => rows.filter((_, i) => i !== index));
        },
      },
    ]);
  };

  const finalItemsForSave = useMemo(() => {
    if (!snapshot) return [];
    const snapItems = Array.isArray(snapshot.items) ? snapshot.items : [];
    // 按 line.sourceIndex 对齐原始 OCR 行，避免删除行后用数组下标错位。
    return lineItems.map((line) => {
      const isUserAdded = line.sourceIndex === null;
      const s = !isUserAdded ? snapItems[line.sourceIndex as number] || {} : {};
      const ocrName = !isUserAdded && typeof s.name === 'string' ? s.name.trim() : '';
      const unitPrice = Number.isFinite(Number(s.unitPrice ?? s.unit_price))
        ? Number(s.unitPrice ?? s.unit_price)
        : 0;
      return {
        ...s,
        name: line.name.trim(),
        ocr_recognized_name: ocrName,
        category: line.category,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
        unitPrice,
        review_source_index: isUserAdded ? null : line.sourceIndex,
        user_added: isUserAdded,
      };
    });
  }, [lineItems, snapshot]);

  const snapItemsArr = Array.isArray(snapshot?.items) ? snapshot.items : [];

  /**
   * 小票保存成功后立即清理对应 draft，并取得队列中的下一张 draft id。
   * 清理失败不会回滚已保存的 receipt（当前无事务机制），但必须保证：
   *  - persistPayloadRef 被清空，避免卸载时再次 flush 已保存的 draft；
   *  - 无论删除成功与否都尝试推进队列，避免用户停留在当前 draft 重复点保存。
   */
  const completeSavedDraftAndGetNext = useCallback(
    async (currentDraftId: string): Promise<string | null> => {
      let removed = false;
      for (let attempt = 1; attempt <= 3 && !removed; attempt++) {
        try {
          await removeScanReviewDraft(currentDraftId);
          removed = true;
        } catch (e) {
          logger.warn('ScanReview', 'removeScanReviewDraft failed', {
            draftId: currentDraftId,
            attempt,
            error: e,
          });
        }
      }
      // 即使删除失败也清空，确保卸载时不再回写已保存 draft。
      persistPayloadRef.current = null;
      try {
        return await peekNextDraftId(currentDraftId);
      } catch (e) {
        logger.warn('ScanReview', 'peekNextDraftId failed', { error: e });
        return null;
      }
    },
    []
  );

  const onDiscard = () => {
    if (saving || saveInFlightRef.current) return;
    const id = String(draftId || '');
    Alert.alert(t('scanReview.discardTitle'), t('scanReview.discardMessage'), [
      { text: t('home.scan.cancel'), style: 'cancel' },
      {
        text: t('scanReview.discardConfirm'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const next = await completeSavedDraftAndGetNext(id);
            if (next) {
              router.replace(`/scan-review/${next}` as any);
            } else {
              router.back();
            }
          })();
        },
      },
    ]);
  };

  const onSave = async () => {
    if (saving || saveInFlightRef.current) return;
    const id = String(draftId || '');
    if (!snapshot || !id) return;

    saveInFlightRef.current = true;
    try {
      const draft = await getScanReviewDraft(id);
      if (!draft) {
        Alert.alert(t('scanReview.missingTitle'), t('scanReview.missingMessage'));
        return;
      }

      setSaving(true);
      const flush = persistPayloadRef.current;
      if (flush && flush.id === id) {
        try {
          await persistScanReviewDraftEditorState(flush.id, flush.state);
        } catch (e) {
          logger.warn('ScanReview', 'Flush draft before save failed', { error: e });
        }
      }

      const review_meta = {
        error_tags: Array.from(errorTags).filter(isReceiptReviewErrorTag),
        trace_id: traceId,
        saved_at: Date.now(),
      };
      const finalAnalysis = {
        ...snapshot,
        merchant: merchant.trim() || undefined,
        transactionDate: dateStr.trim() || undefined,
        total: toNum(totalStr, 0),
        tax: toNum(taxStr, 0),
        currency: currency.trim() || 'JPY',
        items: finalItemsForSave,
        review_meta,
      };

      const source = await getDefaultReceiptSource();
      const receiptId = await saveReceipt({
        imageUri: draft.imageUri,
        source,
        analysis: finalAnalysis,
        recognitionSnapshot: draft.recognitionSnapshot,
        reviewedSave: true,
        note: note.trim() || null,
      });

      // 保存成功即视为不可重复：立刻清理 draft 并推进队列，
      // 避免崩溃/退出/被系统杀进程导致下次重复保存同一张小票。
      const nextDraftId = await completeSavedDraftAndGetNext(id);

      try {
        await applyReviewCorrectionsToLearning({
          snapshotItems: Array.isArray(snapshot.items) ? snapshot.items : [],
          finalItems: finalItemsForSave,
          merchantRaw: merchant.trim() || null,
        });
      } catch (e) {
        logger.warn('ScanReview', 'Learning after save failed', { error: e });
      }

      try {
        await runPostSaveGrowthAnalysis(receiptId);
      } catch (e) {
        logger.warn('ScanReview', 'Post-save growth analysis failed', { error: e });
      }

      const allReceipts = await listReceipts();
      const locale = getCurrentLocale();
      const egg = await tryShowNextEasterEgg(allReceipts.length, allReceipts, locale);
      if (egg.shown && egg.content) {
        await new Promise<void>((resolve) => {
          Alert.alert(
            egg.content.title,
            egg.content.bullets.join('\n\n') + (egg.content.cta ? `\n\n${egg.content.cta}` : ''),
            [{ text: t('easterEgg.ok'), onPress: () => resolve() }]
          );
        });
      }

      Alert.alert(t('scanReview.savedTitle'), t('scanReview.savedMessage'), [
        {
          text: t('easterEgg.ok'),
          onPress: () => {
            // draft 与队列已在保存成功后处理完毕，这里只负责导航。
            if (nextDraftId) {
              router.replace(`/scan-review/${nextDraftId}` as any);
            } else {
              router.back();
            }
          },
        },
      ]);
    } catch (e: any) {
      Alert.alert(t('scanReview.saveFailedTitle'), e?.message ?? String(e));
    } finally {
      setSaving(false);
      saveInFlightRef.current = false;
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top + 40 }]}>
        <ActivityIndicator />
        <Text style={{ marginTop: 12 }}>{t('scanReview.loading')}</Text>
      </View>
    );
  }

  if (missing || !snapshot) {
    return (
      <View style={[styles.center, { paddingTop: insets.top + 40, paddingHorizontal: 24 }]}>
        <Text style={{ textAlign: 'center' }}>{t('scanReview.missingMessage')}</Text>
        <Pressable style={[styles.primaryBtn, { marginTop: 20 }]} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>{t('scanReview.back')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.topBarSide}>
          <Text style={styles.topBarBtn}>{t('scanReview.back')}</Text>
        </Pressable>
        <View style={styles.topBarCenter}>
          <Text style={styles.topBarTitle}>{t('scanReview.title')}</Text>
          <Text style={styles.topBarHint} numberOfLines={2}>
            {t('scanReview.flowHint')}
          </Text>
        </View>
        <Pressable onPress={onDiscard} hitSlop={12} disabled={saving} style={[styles.topBarSide, { alignItems: 'flex-end' }]}>
          <Text style={[styles.topBarBtn, { color: '#c33' }]}>{t('scanReview.discard')}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="contain" />
        ) : null}

        {showDevTrace ? (
          <>
            <Text style={styles.label}>{t('scanReview.traceId')}</Text>
            <Text selectable style={styles.mono}>
              {traceId || '—'}
            </Text>
          </>
        ) : null}

        <Text style={styles.h2}>{t('scanReview.sectionYourEdits')}</Text>
        <Text style={styles.sectionSub}>{t('scanReview.sectionYourEditsSub')}</Text>

        <Text style={styles.label}>{t('scanReview.merchant')}</Text>
        <TextInput value={merchant} onChangeText={setMerchant} style={styles.input} editable={!saving} />

        <Text style={styles.label}>{t('scanReview.date')}</Text>
        <TextInput value={dateStr} onChangeText={setDateStr} style={styles.input} editable={!saving} />

        <View style={styles.row2}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={styles.label}>{t('scanReview.total')}</Text>
            <TextInput value={totalStr} onChangeText={setTotalStr} keyboardType="decimal-pad" style={styles.input} editable={!saving} />
          </View>
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={styles.label}>{t('scanReview.tax')}</Text>
            <TextInput value={taxStr} onChangeText={setTaxStr} keyboardType="decimal-pad" style={styles.input} editable={!saving} />
          </View>
        </View>

        <Text style={styles.label}>{t('scanReview.currency')}</Text>
        <TextInput value={currency} onChangeText={setCurrency} style={styles.input} editable={!saving} />

        <Text style={styles.label}>{t('scanReview.note')}</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          style={[styles.input, { minHeight: 72 }]}
          multiline
          editable={!saving}
          placeholder={t('scanReview.notePlaceholder')}
        />

        <Text style={styles.h2}>{t('scanReview.errorTagsTitle')}</Text>
        <View style={styles.tagWrap}>
          {RECEIPT_REVIEW_ERROR_TAGS.map((tag) => {
            const on = errorTags.has(tag);
            return (
              <Pressable
                key={tag}
                onPress={() => toggleErrorTag(tag)}
                style={[styles.tagChip, on && styles.tagChipOn]}
              >
                <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>
                  {t(`scanReview.errorTags.${tag}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.h2}>{t('scanReview.itemsTitle')}</Text>
        {lineItems.length === 0 ? (
          <Text style={styles.muted}>{t('scanReview.emptyLineItems')}</Text>
        ) : null}
        {lineItems.map((line, idx) => {
          const srcName =
            line.sourceIndex !== null && typeof snapItemsArr[line.sourceIndex]?.name === 'string'
              ? snapItemsArr[line.sourceIndex].name
              : '—';
          return (
          <View key={line.id} style={styles.itemCard}>
            <View style={styles.itemCardHead}>
              <Text style={[styles.ocrHint, { flex: 1, marginBottom: 0 }]} numberOfLines={1}>
                {t('scanReview.recognizedName')}: {srcName}
              </Text>
              <Pressable onPress={() => removeLineItem(idx)} disabled={saving} hitSlop={8}>
                <Text style={[styles.deleteItemBtn, saving && { opacity: 0.4 }]}>
                  {t('scanReview.deleteItem')}
                </Text>
              </Pressable>
            </View>
            <Text style={styles.label}>{t('scanReview.itemName')}</Text>
            <TextInput
              value={line.name}
              onChangeText={(v) => updateLine(idx, { name: v })}
              style={styles.input}
              editable={!saving}
            />
            <Pressable onPress={() => setCategoryModalIndex(idx)} style={styles.catBtn}>
              <Text style={styles.catBtnText}>
                {t('scanReview.category')}: {getCategoryLabel(line.category)}
              </Text>
            </Pressable>
            <View style={styles.row2}>
              <View style={{ flex: 1, marginRight: 6 }}>
                <Text style={styles.label}>{t('scanReview.qty')}</Text>
                <TextInput
                  value={String(line.quantity)}
                  onChangeText={(v) => {
                    const q = parseInt(v.replace(/[^\d]/g, ''), 10);
                    updateLine(idx, { quantity: Number.isFinite(q) && q > 0 ? q : 1 });
                  }}
                  keyboardType="number-pad"
                  style={styles.input}
                  editable={!saving}
                />
              </View>
              <View style={{ flex: 1, marginLeft: 6 }}>
                <Text style={styles.label}>{t('scanReview.lineTotal')}</Text>
                <TextInput
                  value={String(line.lineTotal)}
                  onChangeText={(v) => updateLine(idx, { lineTotal: toNum(v, 0) })}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  editable={!saving}
                />
              </View>
            </View>
          </View>
          );
        })}

        <Pressable
          style={[styles.addItemBtn, saving && { opacity: 0.5 }]}
          onPress={addLineItem}
          disabled={saving}
        >
          <Text style={styles.addItemBtnText}>＋ {t('scanReview.addItem')}</Text>
        </Pressable>

        <Text style={styles.h2}>{t('scanReview.sectionPipelineRef')}</Text>
        <Text style={styles.sectionSub}>{t('scanReview.sectionPipelineRefSub')}</Text>
        <Text style={styles.label}>{t('scanReview.ocrRawTitle')}</Text>
        {ocrText ? (
          <Text selectable style={styles.ocrBlock}>
            {ocrText}
          </Text>
        ) : (
          <Text style={styles.muted}>{t('scanReview.ocrRawEmpty')}</Text>
        )}

        <Text style={styles.saveHint}>{t('scanReview.saveFooterHint')}</Text>
        <Pressable
          style={[styles.primaryBtn, { marginTop: 10, marginBottom: 40 }, saving && { opacity: 0.6 }]}
          onPress={onSave}
          disabled={saving}
        >
          <Text style={styles.primaryBtnText}>{saving ? t('scanReview.saving') : t('scanReview.save')}</Text>
        </Pressable>
      </ScrollView>

      <Modal visible={categoryModalIndex >= 0} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalHead}>
          <Pressable onPress={() => setCategoryModalIndex(-1)}>
            <Text style={styles.modalHeadBtn}>{t('history.detail.edit.cancel')}</Text>
          </Pressable>
          <Text style={styles.modalHeadTitle}>{t('scanReview.categoryModalTitle')}</Text>
          <View style={{ width: 48 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {categoryOptions.map((cat) => (
              <Pressable
                key={cat}
                onPress={() => {
                  if (categoryModalIndex >= 0) updateLine(categoryModalIndex, { category: cat });
                  setCategoryModalIndex(-1);
                }}
              >
                <View
                  style={[
                    styles.catOption,
                    categoryModalIndex >= 0 &&
                      lineItems[categoryModalIndex]?.category === cat &&
                      styles.catOptionOn,
                  ]}
                >
                  <Text
                    style={[
                      styles.catOptionText,
                      categoryModalIndex >= 0 &&
                        lineItems[categoryModalIndex]?.category === cat &&
                        styles.catOptionTextOn,
                    ]}
                  >
                    {getCategoryLabel(cat)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
    backgroundColor: '#fff',
  },
  topBarSide: { minWidth: 56, justifyContent: 'center' },
  topBarCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  topBarTitle: { fontSize: 17, fontWeight: '800', textAlign: 'center' },
  topBarHint: { fontSize: 11, color: '#666', textAlign: 'center', marginTop: 4, lineHeight: 14 },
  topBarBtn: { fontSize: 16, fontWeight: '700', color: '#111' },
  sectionSub: { fontSize: 13, color: '#777', marginTop: -6, marginBottom: 8, lineHeight: 18 },
  saveHint: { fontSize: 13, color: '#555', marginTop: 20, lineHeight: 18 },
  container: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  preview: { width: '100%', height: 200, backgroundColor: '#f0f0f0', borderRadius: 12, marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '700', color: '#666', marginTop: 10, marginBottom: 6 },
  input: {
    backgroundColor: '#f3f3f3',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  mono: { fontSize: 12, color: '#333' },
  row2: { flexDirection: 'row', marginTop: 4 },
  h2: { fontSize: 18, fontWeight: '900', marginTop: 18, marginBottom: 10 },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tagChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#fafafa',
  },
  tagChipOn: { borderColor: '#111', backgroundColor: '#111' },
  tagChipText: { fontSize: 13, fontWeight: '700', color: '#333' },
  tagChipTextOn: { color: '#fff' },
  itemCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e5e5',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#fafafa',
  },
  ocrHint: { fontSize: 12, color: '#888', marginBottom: 8 },
  itemCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  deleteItemBtn: { fontSize: 13, fontWeight: '700', color: '#c33', marginLeft: 12 },
  addItemBtn: {
    marginTop: 4,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#06c',
    borderStyle: 'dashed',
    alignItems: 'center',
    backgroundColor: '#f5f9ff',
  },
  addItemBtnText: { fontSize: 15, fontWeight: '800', color: '#06c' },
  catBtn: { marginTop: 10, alignSelf: 'flex-start' },
  catBtnText: { fontSize: 15, fontWeight: '800', color: '#06c' },
  ocrBlock: { fontSize: 11, color: '#333', backgroundColor: '#f6f6f6', padding: 10, borderRadius: 8 },
  muted: { fontSize: 14, color: '#888' },
  primaryBtn: {
    backgroundColor: '#111',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 16,
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e6e6e6',
  },
  modalHeadBtn: { fontSize: 16, fontWeight: '800', color: '#111' },
  modalHeadTitle: { fontSize: 16, fontWeight: '900' },
  catOption: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#f8f8f8',
  },
  catOptionOn: { borderColor: '#111', backgroundColor: '#111' },
  catOptionText: { fontSize: 14, fontWeight: '700', color: '#333' },
  catOptionTextOn: { color: '#fff' },
});
