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
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MerunoPressable } from '@/components/primitives/MerunoPressable';
import { MerunoText } from '@/components/primitives/MerunoText';
import { ReceiptDuplicateGateCard } from '@/components/review/ReceiptDuplicateGateCard';
import { ReceiptItemCard } from '@/components/review/ReceiptItemCard';
import { ReceiptReviewDetails } from '@/components/review/ReceiptReviewDetails';
import { ReceiptReviewSaveBar } from '@/components/review/ReceiptReviewSaveBar';
import { ReceiptSummaryCard } from '@/components/review/ReceiptSummaryCard';
import { SectionTitle } from '@/components/SectionTitle';
import { listReceipts, saveReceipt } from '@/lib/db';
import { PRODUCT_CATEGORIES, normalizePersistedProductCategory, type ProductCategory } from '@/lib/productCategory';
import { stampUserClassificationProvenance } from '@/lib/productTaxonomy';
import {
  amountCorrectionInput,
  appendUserCorrections,
  buildUserCorrectionEvent,
  categoryCorrectionInput,
  nameCorrectionInput,
  quantityCorrectionInput,
  receiptFieldCorrectionInput,
  applyItemFieldCorrections,
} from '@/lib/userCorrections';
import { applyUserLineAmountEdit } from '@/lib/receiptDiscountAllocation';
import { mergeReviewSnapshotPreservingEvidence } from '@/lib/receiptPrintedEvidence';
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
import {
  bindMerchantAndInvalidateSemanticCache,
  refreshDeterministicProductAttributesFromCurrentName,
} from '@/lib/productIdentitySemanticBatch';
import { buildPostSaveSummaryHref } from '@/lib/postSaveSummaryNavigation';
import { resolveInitialReviewDateStr, reviewDateNeedsConfirm } from '@/lib/scanReviewDateIsolation';
import {
  buildTransientScanReviewReceipt,
  dismissScanReviewDuplicateEvidence,
  evaluateScanReviewDuplicateGate,
  loadScanReviewDuplicateGateContext,
  revalidateScanReviewDuplicateDestination,
  shouldApplyScanReviewDuplicateGateUpdate,
  shouldShowScanReviewDuplicateGateMatch,
  type ScanReviewDuplicateGateContext,
  type ScanReviewDuplicateGateMatch,
} from '@/lib/scanReviewDuplicateGate';
import {
  shouldShowLegacyPostSaveEasterEggAlert,
  shouldShowReviewDevDetails,
} from '@/lib/scanReviewPresentation';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_OPACITY,
  UI_RADIUS,
  UI_SPACING,
} from '@/lib/uiTokens';

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
  classification_source?: string | null;
  classification_version?: string | null;
  taxonomy_version?: string | null;
  categoryUserOverride?: boolean;
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
  const [duplicateGateContext, setDuplicateGateContext] =
    useState<ScanReviewDuplicateGateContext | null>(null);
  const [duplicateGateMatch, setDuplicateGateMatch] =
    useState<ScanReviewDuplicateGateMatch | null>(null);
  const [dismissedDuplicateEvidenceKey, setDismissedDuplicateEvidenceKey] =
    useState<string | null>(null);
  const [duplicateGateProcessing, setDuplicateGateProcessing] = useState(false);
  const persistPayloadRef = useRef<{ id: string; state: ScanReviewEditorStateV1 } | null>(null);
  const saveInFlightRef = useRef(false);
  // 离开保护：程序导航（保存成功/放弃/缺失返回）前置 true 以放行，避免被未保存确认拦截。
  const allowLeaveRef = useRef(false);
  // 离开确认 Alert 是否正在显示，避免同一次返回弹出多个确认框。
  const leavePromptVisibleRef = useRef(false);
  const duplicateGateGenerationRef = useRef(0);
  const duplicateGateMountedRef = useRef(true);
  const currentDraftIdRef = useRef(String(draftId || ''));
  currentDraftIdRef.current = String(draftId || '');

  useEffect(() => {
    duplicateGateMountedRef.current = true;
    return () => {
      duplicateGateMountedRef.current = false;
      duplicateGateGenerationRef.current += 1;
    };
  }, []);

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
    duplicateGateGenerationRef.current += 1;
    setDuplicateGateContext(null);
    setDuplicateGateMatch(null);
    setDismissedDuplicateEvidenceKey(null);
    setDuplicateGateProcessing(false);

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
      const snapCategory =
        typeof (s as any).category === 'string' ? String((s as any).category) : 'uncategorized';
      const snapQty = Number((s as any).quantity);
      const snapAmount = Number((s as any).lineTotal ?? (s as any).line_total);
      let finalItem: Record<string, unknown> = mergeReviewSnapshotPreservingEvidence(s, {
        name: finalName,
        ocr_recognized_name: ocrName,
        category: line.category,
        ...(line.categoryUserOverride ? stampUserClassificationProvenance() : {}),
        quantity: line.quantity,
        lineTotal: line.lineTotal,
        unitPrice,
        review_source_index: isUserAdded ? null : line.sourceIndex,
        user_added: isUserAdded,
        // Bind receipt merchant so semantic fingerprints include merchant context.
        merchant_key: merchant.trim() || null,
        merchant_name: merchant.trim() || null,
      });

      if (!isUserAdded) {
        const beforeQty = Number.isFinite(snapQty) && snapQty > 0 ? snapQty : 1;
        const beforeAmt = Number.isFinite(snapAmount) ? Math.round(snapAmount) : 0;
        const afterAmt = Math.round(Number(line.lineTotal) || 0);
        if (line.quantity !== beforeQty) {
          finalItem = { ...finalItem, quantityUserEdited: true };
        }
        if (afterAmt !== beforeAmt) {
          finalItem = applyUserLineAmountEdit(finalItem as any, afterAmt) as Record<
            string,
            unknown
          >;
        }
        finalItem = applyItemFieldCorrections(finalItem, [
          nameCorrectionInput({
            beforeName: ocrName || classifiedName,
            afterName: finalName,
            itemSourceIndex: line.sourceIndex,
          }),
          quantityCorrectionInput({
            beforeQuantity: beforeQty,
            afterQuantity: line.quantity,
            itemSourceIndex: line.sourceIndex,
          }),
          amountCorrectionInput({
            beforeAmount: beforeAmt,
            afterAmount: afterAmt,
            itemSourceIndex: line.sourceIndex,
          }),
          ...(line.categoryUserOverride || line.category !== snapCategory
            ? [
                categoryCorrectionInput({
                  beforeCategory: snapCategory,
                  afterCategory: line.category,
                  beforeItem: s as {
                    classification_source?: unknown;
                    classification_version?: unknown;
                    taxonomy_version?: unknown;
                  },
                  itemSourceIndex: line.sourceIndex,
                }),
              ]
            : []),
        ]);
      }

      const identified = applyProductIdentityToItem(finalItem, {
        finalName,
        finalCategory: line.category,
        merchantName: merchant.trim() || null,
        // A rename invalidates classifier identity evidence from the snapshot.
        classificationBrand:
          finalName === classifiedName ? (s as any)?.brand : null,
        useExistingClassificationEvidence: finalName === classifiedName,
      });
      // Rebuild deterministic attrs from CURRENT edited name — never keep a
      // stale spread snapshot (e.g. 500ml after rename to 1500ml).
      refreshDeterministicProductAttributesFromCurrentName(identified);
      // Drop stale semantic evidence when name/merchant/deterministic attrs changed.
      bindMerchantAndInvalidateSemanticCache(identified, merchant.trim() || null);
      return identified;
    });
  }, [lineItems, merchant, snapshot]);

  const duplicateGateAnalysis = useMemo(() => {
    if (!snapshot) return null;
    const taxTrimmed = taxStr.trim();
    const parsedTax = taxTrimmed ? toNum(taxTrimmed, NaN) : NaN;
    const taxIsKnown = taxTrimmed.length > 0 && Number.isFinite(parsedTax);
    return mergeReviewSnapshotPreservingEvidence(
      snapshot as Record<string, unknown>,
      {
        merchant: merchant.trim() || undefined,
        transactionDate: dateStr.trim() || undefined,
        total: toNum(totalStr, 0),
        tax: taxIsKnown ? parsedTax : null,
        tax_is_known: taxIsKnown,
        currency: currency.trim() || 'JPY',
        items: finalItemsForSave,
      }
    ) as any;
  }, [snapshot, merchant, dateStr, totalStr, taxStr, currency, finalItemsForSave]);

  // Load the exhaustive current-owner context once per reviewable draft. Later
  // material edits only re-evaluate the transient receipt against this context.
  useEffect(() => {
    const capturedDraftId = String(draftId || '');
    if (loading || missing || !snapshot || !capturedDraftId) return;
    const capturedGeneration = ++duplicateGateGenerationRef.current;
    void loadScanReviewDuplicateGateContext().then((context) => {
      if (
        !shouldApplyScanReviewDuplicateGateUpdate({
          mounted: duplicateGateMountedRef.current,
          capturedGeneration,
          currentGeneration: duplicateGateGenerationRef.current,
          capturedDraftId,
          currentDraftId: currentDraftIdRef.current,
        })
      ) {
        return;
      }
      setDuplicateGateContext(context);
    });
  }, [draftId, loading, missing, snapshot]);

  // Material review evidence is debounced. Every new evaluation invalidates
  // older timers/results, and the route-scoped guard blocks stale draft writes.
  useEffect(() => {
    const capturedDraftId = String(draftId || '');
    if (
      loading ||
      missing ||
      !duplicateGateContext ||
      !duplicateGateAnalysis ||
      !capturedDraftId
    ) {
      setDuplicateGateMatch(null);
      return;
    }
    const capturedGeneration = ++duplicateGateGenerationRef.current;
    setDuplicateGateMatch(null);
    const timer = setTimeout(() => {
      let match: ScanReviewDuplicateGateMatch | null = null;
      try {
        const transient = buildTransientScanReviewReceipt({
          transientReceiptId: `scan-review:${capturedDraftId}`,
          imageUri,
          analysis: duplicateGateAnalysis,
        });
        match = transient
          ? evaluateScanReviewDuplicateGate(transient, duplicateGateContext)
          : null;
      } catch (error) {
        logger.warn('ScanReview', 'Duplicate gate evaluation failed', { error });
      }
      if (
        !shouldApplyScanReviewDuplicateGateUpdate({
          mounted: duplicateGateMountedRef.current,
          capturedGeneration,
          currentGeneration: duplicateGateGenerationRef.current,
          capturedDraftId,
          currentDraftId: currentDraftIdRef.current,
        })
      ) {
        return;
      }
      setDuplicateGateMatch(
        shouldShowScanReviewDuplicateGateMatch(
          match,
          dismissedDuplicateEvidenceKey
        )
          ? match
          : null
      );
    }, 450);
    return () => clearTimeout(timer);
  }, [
    draftId,
    loading,
    missing,
    imageUri,
    duplicateGateContext,
    duplicateGateAnalysis,
    dismissedDuplicateEvidenceKey,
  ]);

  const onContinueDuplicateReview = useCallback(() => {
    if (!duplicateGateMatch || duplicateGateProcessing) return;
    setDismissedDuplicateEvidenceKey(
      dismissScanReviewDuplicateEvidence(duplicateGateMatch)
    );
    setDuplicateGateMatch(null);
  }, [duplicateGateMatch, duplicateGateProcessing]);

  const onViewSavedDuplicateReceipt = useCallback(() => {
    if (!duplicateGateMatch || duplicateGateProcessing) return;
    const capturedDraftId = String(draftId || '');
    const destinationId = duplicateGateMatch.existingReceiptId;
    setDuplicateGateProcessing(true);
    void (async () => {
      await flushPendingEditorState();
      const stillOwned = await revalidateScanReviewDuplicateDestination(
        destinationId
      );
      if (
        !duplicateGateMountedRef.current ||
        currentDraftIdRef.current !== capturedDraftId
      ) {
        return;
      }
      if (!stillOwned) {
        setDuplicateGateMatch(null);
        return;
      }
      router.push(`/history/${encodeURIComponent(destinationId)}` as any);
    })()
      .catch((error) => {
        logger.warn('ScanReview', 'View saved duplicate failed', { error });
      })
      .finally(() => {
        if (
          duplicateGateMountedRef.current &&
          currentDraftIdRef.current === capturedDraftId
        ) {
          setDuplicateGateProcessing(false);
        }
      });
  }, [
    draftId,
    duplicateGateMatch,
    duplicateGateProcessing,
    flushPendingEditorState,
    router,
  ]);

  const snapItemsArr = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const showDevDetails = shouldShowReviewDevDetails(showDevTrace, __DEV__);
  const showDuplicateGate = shouldShowScanReviewDuplicateGateMatch(
    duplicateGateMatch,
    dismissedDuplicateEvidenceKey
  );
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
      const snapMerchant =
        typeof (snapshot as any)?.merchant === 'string' ? String((snapshot as any).merchant) : '';
      const snapDate =
        typeof (snapshot as any)?.transactionDate === 'string'
          ? String((snapshot as any).transactionDate)
          : typeof (snapshot as any)?.transaction_date === 'string'
            ? String((snapshot as any).transaction_date)
            : '';
      const snapTotal = Number((snapshot as any)?.total);
      const snapTax = Number((snapshot as any)?.tax);
      const receiptCorrectionEvents = [
        buildUserCorrectionEvent(
          receiptFieldCorrectionInput({
            field: 'merchant',
            originalValue: snapMerchant,
            correctedValue: merchant.trim(),
          })
        ),
        buildUserCorrectionEvent(
          receiptFieldCorrectionInput({
            field: 'transaction_date',
            originalValue: snapDate,
            correctedValue: dateStr.trim(),
          })
        ),
        buildUserCorrectionEvent(
          receiptFieldCorrectionInput({
            field: 'receipt_total',
            originalValue: Number.isFinite(snapTotal) ? snapTotal : null,
            correctedValue: toNum(totalStr, 0),
          })
        ),
        buildUserCorrectionEvent(
          receiptFieldCorrectionInput({
            field: 'receipt_tax',
            originalValue: Number.isFinite(snapTax) ? snapTax : null,
            correctedValue: taxIsKnown ? taxValue : null,
          })
        ),
        buildUserCorrectionEvent(
          receiptFieldCorrectionInput({
            field: 'receipt_note',
            originalValue:
              typeof (snapshot as any)?.note === 'string'
                ? String((snapshot as any).note)
                : '',
            correctedValue: note.trim(),
          })
        ),
      ].filter((e): e is NonNullable<typeof e> => e != null);

      const snapshotMerchant =
        typeof (snapshot as { merchant?: unknown }).merchant === 'string'
          ? String((snapshot as { merchant: string }).merchant).trim()
          : '';
      const editedMerchant = merchant.trim();
      const merchantObservationChanged = snapshotMerchant !== editedMerchant;

      const finalAnalysis = appendUserCorrections(
        mergeReviewSnapshotPreservingEvidence(snapshot as Record<string, unknown>, {
          merchant: editedMerchant || undefined,
          // Drop stale derived merchant metadata when the user changes the observation.
          ...(merchantObservationChanged
            ? { merchant_normalized: undefined, merchant_type: undefined }
            : {}),
          transactionDate: dateStr.trim() || undefined,
          total: toNum(totalStr, 0),
          tax: taxIsKnown ? taxValue : null,
          tax_is_known: taxIsKnown,
          currency: currency.trim() || 'JPY',
          items: finalItemsForSave,
          review_meta,
        }),
        receiptCorrectionEvents
      ) as typeof snapshot & {
        merchant?: string;
        transactionDate?: string;
        total: number;
        tax: number | null;
        tax_is_known?: boolean;
        currency?: string;
        items?: unknown[];
        review_meta?: unknown;
        user_corrections?: unknown;
      };

      const source = await getDefaultReceiptSource();
      const receiptId = await saveReceipt({
        imageUri: draft.imageUri,
        source,
        analysis: finalAnalysis,
        recognitionSnapshot: draft.recognitionSnapshot,
        reviewedSave: true,
        note: note.trim() || null,
        ocrRequestId: draft.ocrRequestId ?? null,
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
        <ActivityIndicator color={UI_COLORS.accent} />
        <MerunoText role="meta" tone="secondary" style={styles.loadingText}>
          {t('scanReview.loading')}
        </MerunoText>
      </View>
    );
  }

  if (missing || !snapshot) {
    return (
      <View style={[styles.center, { paddingTop: insets.top + 40, paddingHorizontal: UI_SPACING.xxl }]}>
        <MerunoText role="bodySmall" tone="secondary" style={styles.missingText}>
          {t('scanReview.missingMessage')}
        </MerunoText>
        <MerunoPressable
          style={styles.primaryBtn}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.back')}
        >
          <MerunoText role="button" tone="inverse">
            {t('scanReview.back')}
          </MerunoText>
        </MerunoPressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.topBar, { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGapCompact }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.topBarSide}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.back')}
        >
          <MerunoText role="bodySmall" tone="accent" style={styles.topBarBtn}>
            {t('scanReview.back')}
          </MerunoText>
        </Pressable>
        <View style={styles.topBarCenter}>
          <MerunoText role="bodySmall" tone="primary" style={styles.topBarTitle}>
            {t('scanReview.title')}
          </MerunoText>
          <MerunoText role="caption" tone="muted" style={styles.topBarHint} numberOfLines={1}>
            {t('scanReview.flowHint')}
          </MerunoText>
        </View>
        <Pressable
          onPress={onDiscard}
          hitSlop={12}
          disabled={saving}
          style={[styles.topBarSide, styles.topBarSideEnd]}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.discard')}
        >
          <MerunoText
            role="bodySmall"
            tone="destructive"
            style={[styles.discardBtn, saving && styles.discardDisabled]}
          >
            {t('scanReview.discard')}
          </MerunoText>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: bottomPadding }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {imageUri ? (
          <View style={styles.previewFrame}>
            <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="contain" />
          </View>
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

        {showDuplicateGate ? (
          <ReceiptDuplicateGateCard
            match={duplicateGateMatch!}
            processing={duplicateGateProcessing}
            onViewSavedReceipt={onViewSavedDuplicateReceipt}
            onContinueReview={onContinueDuplicateReview}
          />
        ) : null}

        <View style={styles.itemsHeader}>
          <SectionTitle
            title={t('scanReview.itemsTitle')}
            subtitle={t('scanReview.itemsCount', { count: lineItems.length })}
            style={styles.itemsSectionTitle}
          />
        </View>

        {lineItems.length === 0 ? (
          <MerunoText role="meta" tone="muted" style={styles.muted}>
            {t('scanReview.emptyLineItems')}
          </MerunoText>
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
                showDivider={idx < lineItems.length - 1}
              />
            );
          })}
        </View>

        <MerunoPressable
          style={[styles.addItemBtn, saving && styles.addItemDisabled]}
          onPress={addLineItem}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={t('scanReview.addItem')}
        >
          <MerunoText role="bodySmall" tone="accent" style={styles.addItemBtnText}>
            ＋ {t('scanReview.addItem')}
          </MerunoText>
        </MerunoPressable>

        <ReceiptReviewDetails
          errorTags={errorTags}
          onToggleErrorTag={toggleErrorTag}
          showDevDetails={showDevDetails}
          traceId={traceId}
          ocrText={ocrText}
        />
      </ScrollView>

      {!showDuplicateGate ? (
        <ReceiptReviewSaveBar
          saving={saving}
          bottomInset={insets.bottom}
          onSave={onSave}
          onLayoutHeight={setStickyHeight}
        />
      ) : null}

      <Modal visible={categoryModalIndex >= 0} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalHead}>
          <Pressable
            onPress={() => setCategoryModalIndex(-1)}
            accessibilityRole="button"
            accessibilityLabel={t('history.detail.edit.cancel')}
          >
            <MerunoText role="bodySmall" tone="accent" style={styles.modalHeadBtn}>
              {t('history.detail.edit.cancel')}
            </MerunoText>
          </Pressable>
          <MerunoText role="bodySmall" tone="primary" style={styles.modalHeadTitle}>
            {t('scanReview.categoryModalTitle')}
          </MerunoText>
          <View style={styles.modalHeadSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.modalBody}>
          <View style={styles.catOptionWrap}>
            {categoryOptions.map((cat) => {
              const selected =
                categoryModalIndex >= 0 &&
                lineItems[categoryModalIndex]?.category === cat;
              return (
                <Pressable
                  key={cat}
                  onPress={() => {
                    if (categoryModalIndex >= 0) {
                      updateLine(categoryModalIndex, {
                        category: cat,
                        categoryUserOverride: true,
                        ...stampUserClassificationProvenance(),
                      });
                    }
                    setCategoryModalIndex(-1);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={getCategoryLabel(cat)}
                  style={({ pressed }) => [
                    styles.catOption,
                    selected && styles.catOptionOn,
                    pressed && !selected && styles.catOptionPressed,
                  ]}
                >
                  <MerunoText
                    role="chip"
                    tone={selected ? 'inverse' : 'primary'}
                    style={styles.catOptionText}
                  >
                    {getCategoryLabel(cat)}
                  </MerunoText>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: UI_COLORS.background,
  },
  loadingText: {
    marginTop: UI_SPACING.md,
  },
  missingText: {
    textAlign: 'center',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: UI_SPACING.md,
    paddingBottom: UI_SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surface,
  },
  topBarSide: { minWidth: 56, justifyContent: 'center' },
  topBarSideEnd: { alignItems: 'flex-end' },
  topBarCenter: { flex: 1, alignItems: 'center', paddingHorizontal: UI_SPACING.xs },
  topBarTitle: { fontWeight: '800', textAlign: 'center' },
  topBarHint: {
    textAlign: 'center',
    marginTop: 2,
  },
  topBarBtn: { fontWeight: '700' },
  discardBtn: { fontWeight: '600' },
  discardDisabled: { opacity: UI_OPACITY.disabled },
  container: {
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingTop: 14,
  },
  previewFrame: {
    width: '100%',
    height: 148,
    backgroundColor: UI_COLORS.surfaceMuted,
    borderRadius: UI_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    marginBottom: 14,
    overflow: 'hidden',
  },
  preview: {
    width: '100%',
    height: 148,
  },
  itemsHeader: {
    marginTop: UI_SPACING.sm,
  },
  itemsSectionTitle: {
    marginTop: UI_LAYOUT.sectionGap,
    marginBottom: UI_SPACING.md,
  },
  itemList: {
    borderRadius: UI_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surface,
    overflow: 'hidden',
  },
  muted: { marginBottom: UI_SPACING.sm },
  addItemBtn: {
    marginTop: UI_SPACING.md,
    marginBottom: UI_SPACING.sm,
    paddingVertical: 13,
    minHeight: UI_LAYOUT.controlMinHeight,
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_COLORS.surface,
  },
  addItemBtnText: { fontWeight: '700' },
  addItemDisabled: {
    opacity: UI_OPACITY.disabled,
  },
  primaryBtn: {
    marginTop: UI_SPACING.xl,
    backgroundColor: UI_COLORS.accent,
    paddingVertical: 14,
    borderRadius: UI_RADIUS.control,
    alignItems: 'center',
    paddingHorizontal: UI_SPACING.xxl,
  },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: UI_SPACING.lg,
    paddingHorizontal: UI_SPACING.md,
    paddingBottom: UI_SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surface,
  },
  modalHeadBtn: { fontWeight: '700' },
  modalHeadTitle: { fontWeight: '800' },
  modalHeadSpacer: { width: 48 },
  modalBody: {
    padding: UI_SPACING.lg,
    paddingBottom: 40,
  },
  catOptionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: UI_SPACING.sm,
  },
  catOption: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: UI_RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surfaceMuted,
  },
  catOptionOn: {
    borderColor: UI_COLORS.accent,
    backgroundColor: UI_COLORS.accent,
  },
  catOptionPressed: {
    backgroundColor: UI_COLORS.accentSoft,
  },
  catOptionText: { fontWeight: '700' },
});
