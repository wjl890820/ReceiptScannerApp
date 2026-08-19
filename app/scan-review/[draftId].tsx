import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReceiptItemCard } from '@/components/review/ReceiptItemCard';
import { ReceiptReviewDetails } from '@/components/review/ReceiptReviewDetails';
import { ReceiptReviewSaveBar } from '@/components/review/ReceiptReviewSaveBar';
import { ReceiptSummaryCard } from '@/components/review/ReceiptSummaryCard';
import { listReceipts, saveReceipt } from '@/lib/db';
import { PRODUCT_CATEGORIES, normalizePersistedProductCategory, type ProductCategory } from '@/lib/productCategory';
import { taxFieldPrefillFromSnapshot } from '@/lib/receiptListHelpers';
import { getCategoryLabel } from '@/lib/categoryPalette';
import { getCurrentLocale, t } from '@/lib/i18n';
import { tryShowNextEasterEgg } from '@/lib/homeEasterEggHelpers';
import { getDefaultReceiptSource } from '@/lib/receiptSourceSettings';
import { applyReviewCorrectionsToLearning } from '@/lib/receiptReviewLearning';
import { runPostSaveGrowthAnalysis } from '@/lib/postSaveGrowthAnalysis';
import { isReceiptReviewErrorTag } from '@/lib/reviewErrorTags';
import {
  getScanReviewDraft,
  persistScanReviewDraftEditorState,
  removeScanReviewDraft,
  type ScanReviewEditorStateV1,
} from '@/lib/scanReviewDraftStore';
import { peekNextDraftId } from '@/lib/scanReviewQueue';
import { logger } from '@/lib/logger';
import { isDevToolsUnlocked } from '@/lib/devToolsAccess';
import { applyProductIdentityToItem } from '@/lib/receiptItemIdentity';
import { buildPostSaveSummaryHref } from '@/lib/postSaveSummaryNavigation';
import { resolveInitialReviewDateStr, reviewDateNeedsConfirm } from '@/lib/scanReviewDateIsolation';
import {
  shouldShowLegacyPostSaveEasterEggAlert,
  shouldShowReviewDevDetails,
} from '@/lib/scanReviewPresentation';

function toNum(v: string, fallback = 0): number {
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}

const categoryOptions = PRODUCT_CATEGORIES;

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
  category: ProductCategory;
  quantity: number;
  lineTotal: number;
};

export default function ScanReviewScreen() {
  const router = useRouter();
  const navigation = useNavigation();
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
  const [stickyHeight, setStickyHeight] = useState(0);
  const persistPayloadRef = useRef<{ id: string; state: ScanReviewEditorStateV1 } | null>(null);
  const saveInFlightRef = useRef(false);
  // 离开保护：程序导航（保存成功/放弃/缺失返回）前置 true 以放行，避免被未保存确认拦截。
  const allowLeaveRef = useRef(false);
  // 离开确认 Alert 是否正在显示，避免同一次返回弹出多个确认框。
  const leavePromptVisibleRef = useRef(false);

  useEffect(() => {
    let c = false;
    void isDevToolsUnlocked().then((on) => {
      if (!c) setShowDevTrace(on);
    });
    return () => {
      c = true;
    };
  }, []);

  const applySnapshotDefaults = useCallback((snap: any, editorState?: ScanReviewEditorStateV1) => {
    setMerchant(typeof snap?.merchant === 'string' ? snap.merchant : '');
    setDateStr(
      resolveInitialReviewDateStr({
        editorState,
        snapshotTransactionDate:
          typeof snap?.transactionDate === 'string' ? snap.transactionDate : null,
      })
    );
    setTotalStr(String(snap?.total ?? ''));
    setTaxStr(taxFieldPrefillFromSnapshot(snap));
    setCurrency(typeof snap?.currency === 'string' && snap.currency.trim() ? snap.currency : 'JPY');
    setNote('');
    setOcrText(typeof snap?.ocr_raw_text === 'string' ? snap.ocr_raw_text : '');
    const items = Array.isArray(snap?.items) ? snap.items : [];
    setLineItems(
      items.map((it: any, idx: number) => ({
        id: makeLineId(),
        sourceIndex: idx,
        name: typeof it?.name === 'string' ? it.name : '',
        category: normalizePersistedProductCategory(it?.category, typeof it?.name === 'string' ? it.name : undefined),
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
    const id = String(draftId || '');
    // Clear stale editor state immediately when switching drafts (Sample 087).
    setLoading(true);
    setMissing(false);
    setSnapshot(null);
    setMerchant('');
    setDateStr('');
    setTotalStr('');
    setTaxStr('');
    setCurrency('JPY');
    setNote('');
    setLineItems([]);
    setErrorTags(new Set());
    setOcrText('');
    setImageUri('');
    setTraceId('');

    (async () => {
      if (!id) {
        if (!cancelled) {
          setMissing(true);
          setLoading(false);
        }
        return;
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
        setDateStr(resolveInitialReviewDateStr({ editorState: es, snapshotTransactionDate: snap?.transactionDate }));
        setTotalStr(typeof es.totalStr === 'string' ? es.totalStr : String(snap?.total ?? ''));
        if (typeof es.taxStr === 'string') {
          setTaxStr(es.taxStr);
        } else {
          setTaxStr(taxFieldPrefillFromSnapshot(snap));
        }
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
              category: normalizePersistedProductCategory(li.category, typeof li.name === 'string' ? li.name : undefined),
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

  // 离开前尽量 flush 一次最新 editor state；失败也不阻止离开（debounce + 卸载 flush 兜底）。
  const flushPendingEditorState = useCallback(async () => {
    const p = persistPayloadRef.current;
    if (!p) return;
    try {
      await persistScanReviewDraftEditorState(p.id, p.state);
    } catch (e) {
      logger.warn('ScanReview', 'flushPendingEditorState failed', { error: e });
    }
  }, []);

  // 每次渲染同步“是否为有效未保存草稿”的基础条件（基于 state/props，事件时再叠加 refs）。
  const leaveGuardBaseRef = useRef(false);
  leaveGuardBaseRef.current = !loading && !missing && !!draftId && !!snapshot && !saving;

  // 离开保护：拦截系统返回 / 硬件返回 / 手势返回 / 顶部返回 / 程序外部 remove。
  // 仅用 beforeRemove 单一监听，避免与 BackHandler 形成双重弹窗。
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e: any) => {
      const shouldBlock =
        leaveGuardBaseRef.current && !saveInFlightRef.current && !allowLeaveRef.current;
      if (!shouldBlock) {
        // 放行：保存成功/放弃/缺失返回等程序导航，或非未保存场景。
        return;
      }
      e.preventDefault();
      if (leavePromptVisibleRef.current) return;
      leavePromptVisibleRef.current = true;
      Alert.alert(t('scanReview.leaveGuardTitle'), t('scanReview.leaveGuardMessage'), [
        {
          text: t('scanReview.leaveGuardStay'),
          style: 'cancel',
          onPress: () => {
            leavePromptVisibleRef.current = false;
          },
        },
        {
          text: t('scanReview.leaveGuardLeave'),
          style: 'destructive',
          onPress: () => {
            leavePromptVisibleRef.current = false;
            // 保留 draft：不清理、不保存到历史，仅放行离开；离开前 flush 最新编辑态。
            allowLeaveRef.current = true;
            void flushPendingEditorState().finally(() => {
              navigation.dispatch(e.data.action);
            });
          },
        },
      ]);
    });
    return unsub;
  }, [navigation, flushPendingEditorState]);

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
      { id: makeLineId(), sourceIndex: null, name: '', category: 'uncategorized' as ProductCategory, quantity: 1, lineTotal: 0 },
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
      const finalName = line.name.trim();
      const classifiedName = typeof s.name === 'string' ? s.name.trim() : '';
      const finalItem = {
        ...s,
        name: finalName,
        ocr_recognized_name: ocrName,
        category: line.category,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
        unitPrice,
        review_source_index: isUserAdded ? null : line.sourceIndex,
        user_added: isUserAdded,
      };
      return applyProductIdentityToItem(finalItem, {
        finalName,
        finalCategory: line.category,
        merchantName: merchant.trim() || null,
        // A rename invalidates classifier identity evidence from the snapshot.
        classificationBrand:
          finalName === classifiedName ? (s as any)?.brand : null,
        useExistingClassificationEvidence: finalName === classifiedName,
      });
    });
  }, [lineItems, merchant, snapshot]);

  const snapItemsArr = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const showDevDetails = shouldShowReviewDevDetails(showDevTrace, __DEV__);
  const FALLBACK_STICKY_HEIGHT = 88;
  const bottomPadding = (stickyHeight || FALLBACK_STICKY_HEIGHT) + 20;

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
            // 放弃是用户明确意图，导航前放行离开保护，避免再弹未保存确认。
            allowLeaveRef.current = true;
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
      const taxTrimmed = taxStr.trim();
      let taxValue: number | null = null;
      let taxIsKnown = false;
      if (taxTrimmed) {
        const parsedTax = toNum(taxTrimmed, NaN);
        if (Number.isFinite(parsedTax)) {
          taxValue = parsedTax;
          taxIsKnown = true;
        }
      }
      const finalAnalysis = {
        ...snapshot,
        merchant: merchant.trim() || undefined,
        transactionDate: dateStr.trim() || undefined,
        total: toNum(totalStr, 0),
        tax: taxIsKnown ? taxValue : null,
        tax_is_known: taxIsKnown,
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

      // Release: Post-Save Summary is the only milestone presentation.
      // Keep legacy Alert only for __DEV__ (still computes nothing mandatory).
      if (shouldShowLegacyPostSaveEasterEggAlert(__DEV__)) {
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
      }

      // draft、queue、learning 与 post-save 工作均已完成；这里只替换最终展示目的地。
      // replace 会移除已删除 draft 的 editor，避免 Back 返回旧审核页。
      allowLeaveRef.current = true;
      router.replace(
        buildPostSaveSummaryHref(receiptId, nextDraftId) as any
      );
    } catch (e: any) {
      // 保存失败：保留 draft、不清队列、不放行离开、不跳转；技术细节进日志。
      logger.warn('ScanReview', 'Save failed', { error: e });
      Alert.alert(t('scanReview.saveFailedTitle'), t('scanReview.saveFailedMessage'));
    } finally {
      setSaving(false);
      saveInFlightRef.current = false;
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top + 40 }]}>
        <ActivityIndicator color="#1677ff" />
        <Text style={{ marginTop: 12, color: '#68707a' }}>{t('scanReview.loading')}</Text>
      </View>
    );
  }

  if (missing || !snapshot) {
    return (
      <View style={[styles.center, { paddingTop: insets.top + 40, paddingHorizontal: 24 }]}>
        <Text style={{ textAlign: 'center', color: '#3f4751' }}>{t('scanReview.missingMessage')}</Text>
        <Pressable style={[styles.primaryBtn, { marginTop: 20 }]} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>{t('scanReview.back')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.topBarSide}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.back')}
        >
          <Text style={styles.topBarBtn}>{t('scanReview.back')}</Text>
        </Pressable>
        <View style={styles.topBarCenter}>
          <Text style={styles.topBarTitle}>{t('scanReview.title')}</Text>
          <Text style={styles.topBarHint} numberOfLines={2}>
            {t('scanReview.flowHint')}
          </Text>
        </View>
        <Pressable
          onPress={onDiscard}
          hitSlop={12}
          disabled={saving}
          style={[styles.topBarSide, { alignItems: 'flex-end' }]}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.discard')}
        >
          <Text style={[styles.topBarBtn, styles.discardBtn, saving && { opacity: 0.4 }]}>
            {t('scanReview.discard')}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: bottomPadding }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="contain" />
        ) : null}

        <ReceiptSummaryCard
          merchant={merchant}
          dateStr={dateStr}
          totalStr={totalStr}
          taxStr={taxStr}
          currency={currency}
          note={note}
          amountMismatch={Boolean(snapshot?.amount_mismatch)}
          dateNeedsConfirm={reviewDateNeedsConfirm(dateStr, merchant)}
          editable={!saving}
          onMerchantChange={setMerchant}
          onDateChange={setDateStr}
          onTotalChange={setTotalStr}
          onTaxChange={setTaxStr}
          onCurrencyChange={setCurrency}
          onNoteChange={setNote}
        />

        <View style={styles.itemsHeader}>
          <Text style={styles.itemsTitle}>{t('scanReview.itemsTitle')}</Text>
          <Text style={styles.itemsCount}>
            {t('scanReview.itemsCount', { count: lineItems.length })}
          </Text>
        </View>

        {lineItems.length === 0 ? (
          <Text style={styles.muted}>{t('scanReview.emptyLineItems')}</Text>
        ) : null}

        <View style={styles.itemList}>
          {lineItems.map((line, idx) => {
            const recognizedName =
              line.sourceIndex !== null
                ? snapItemsArr[line.sourceIndex]?.name
                : null;
            return (
              <ReceiptItemCard
                key={line.id}
                name={line.name}
                category={line.category}
                quantity={line.quantity}
                lineTotal={line.lineTotal}
                recognizedName={recognizedName}
                editable={!saving}
                onNameChange={(v) => updateLine(idx, { name: v })}
                onCategoryPress={() => setCategoryModalIndex(idx)}
                onQuantityChange={(v) => {
                  const q = parseInt(v.replace(/[^\d]/g, ''), 10);
                  updateLine(idx, {
                    quantity: Number.isFinite(q) && q > 0 ? q : 1,
                  });
                }}
                onLineTotalChange={(v) =>
                  updateLine(idx, { lineTotal: toNum(v, 0) })
                }
                onDelete={() => removeLineItem(idx)}
              />
            );
          })}
        </View>

        <Pressable
          style={[styles.addItemBtn, saving && { opacity: 0.5 }]}
          onPress={addLineItem}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.addItem')}
        >
          <Text style={styles.addItemBtnText}>＋ {t('scanReview.addItem')}</Text>
        </Pressable>

        <ReceiptReviewDetails
          errorTags={errorTags}
          onToggleErrorTag={toggleErrorTag}
          showDevDetails={showDevDetails}
          traceId={traceId}
          ocrText={ocrText}
        />
      </ScrollView>

      <ReceiptReviewSaveBar
        saving={saving}
        bottomInset={insets.bottom}
        onSave={onSave}
        onLayoutHeight={setStickyHeight}
      />

      <Modal visible={categoryModalIndex >= 0} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalHead}>
          <Pressable
            onPress={() => setCategoryModalIndex(-1)}
            accessibilityRole="button"
            accessibilityLabel={t('history.detail.edit.cancel')}
          >
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
                accessibilityRole="button"
                accessibilityLabel={getCategoryLabel(cat)}
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f7f8fa',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f7f8fa',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e7e9ec',
    backgroundColor: '#fff',
  },
  topBarSide: { minWidth: 56, justifyContent: 'center' },
  topBarCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  topBarTitle: { fontSize: 17, fontWeight: '800', textAlign: 'center', color: '#15181c' },
  topBarHint: {
    fontSize: 12,
    color: '#68707a',
    textAlign: 'center',
    marginTop: 3,
    lineHeight: 16,
  },
  topBarBtn: { fontSize: 16, fontWeight: '700', color: '#1677ff' },
  discardBtn: { color: '#d94848' },
  container: { paddingHorizontal: 16, paddingTop: 14 },
  preview: {
    width: '100%',
    height: 148,
    backgroundColor: '#eef1f4',
    borderRadius: 14,
    marginBottom: 14,
  },
  itemsHeader: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  itemsTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#171a1f',
  },
  itemsCount: {
    fontSize: 13,
    color: '#8a929c',
    fontWeight: '600',
  },
  itemList: {
    gap: 10,
  },
  muted: { fontSize: 14, color: '#8a929c', marginBottom: 8 },
  addItemBtn: {
    marginTop: 12,
    marginBottom: 8,
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#cfe1fb',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  addItemBtnText: { fontSize: 15, fontWeight: '800', color: '#1677ff' },
  primaryBtn: {
    backgroundColor: '#1677ff',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    paddingHorizontal: 24,
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
    backgroundColor: '#fff',
  },
  modalHeadBtn: { fontSize: 16, fontWeight: '800', color: '#1677ff' },
  modalHeadTitle: { fontSize: 16, fontWeight: '900', color: '#15181c' },
  catOption: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d7dde5',
    backgroundColor: '#f5f7fa',
  },
  catOptionOn: { borderColor: '#1677ff', backgroundColor: '#1677ff' },
  catOptionText: { fontSize: 14, fontWeight: '700', color: '#3f4751' },
  catOptionTextOn: { color: '#fff' },
});
