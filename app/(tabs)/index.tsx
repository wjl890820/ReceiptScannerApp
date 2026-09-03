// app/(tabs)/index.tsx

import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProgressiveHomeInsights } from '@/components/ProgressiveHomeInsights';
import type { ReceiptAnalysis, ReceiptItem } from '@/lib/receiptAnalyzer';
import { pingOcrEdge, probeSupabaseNetwork } from '@/lib/ocrService';
import {
  runScanPipelineToReview,
  type ScanOneResult,
} from '@/lib/scanPipeline';
import {
  collectFailedScanItems,
  mergeDraftIdsAfterRetry,
  buildBatchFailureSummary,
  type FailedScanItem,
} from '@/lib/scanRetryHelpers';
import {
  setScanReviewQueue,
  clearScanReviewQueue,
  getPendingScanReviewState,
  type PendingScanReviewState,
} from '@/lib/scanReviewQueue';
import { getScanErrorMessage } from '@/lib/scanError';
import { logger } from '@/lib/logger';

import { selectAnalyticsReceipts } from '@/lib/analyticsReceiptSelection';
import {
  listReceipts,
  getReceiptsDatabase,
  type ReceiptRow,
} from '@/lib/db';
import {
  evaluateCurrentEngagementMilestone,
  loadEngagementProductInsightContext,
  type MilestoneFrequentProduct,
} from '@/lib/engagementMilestones';
import {
  buildHomeProgressiveExperience,
  type HomeProgressiveExperience,
} from '@/lib/homeProgressiveExperience';
import { loadPersonalProductEndpointInventoryWithDb } from '@/lib/personalProductEndpointInventory';
import {
  beginHomeRefresh,
  completeHomeRefresh,
  failHomeRefresh,
  INITIAL_HOME_REFRESH_STATE,
  isLatestHomeRefresh,
} from '@/lib/homeRefreshState';
import { t } from '@/lib/i18n';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
  UI_SHADOW,
  UI_TYPOGRAPHY,
} from '@/lib/uiTokens';
import {
  buildHomeFrequentProductDetailHref,
} from '@/lib/homeValueHierarchy';
// 商品分类由 receiptEnricher.applyCategoriesWithLearning 完成（规则 + classify-item AI + 学习表），在 lib/scanPipeline 内调用
export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [homeRefreshState, setHomeRefreshState] = useState(
    INITIAL_HOME_REFRESH_STATE
  );
  const hasCompleteSnapshotRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const [homeExperience, setHomeExperience] =
    useState<HomeProgressiveExperience>(() =>
      buildHomeProgressiveExperience([], null)
    );
  const [scanning, setScanning] = useState(false);
  const [processingProgress, setProcessingProgress] = useState<{ current: number; total: number } | null>(null);
  const [stickyHeight, setStickyHeight] = useState(0);
  const [pendingReview, setPendingReview] = useState<PendingScanReviewState>({
    nextDraftId: null,
    pendingCount: 0,
  });


  // 加载所有收据； progressive analytics 使用去重后的 purchase candidates
  const loadReceipts = useCallback(async () => {
    const requestGeneration = ++refreshGenerationRef.current;
    const hadCompleteSnapshot = hasCompleteSnapshotRef.current;
    setHomeRefreshState((state) => beginHomeRefresh(state));
    try {
      const allReceipts = await listReceipts();
      const analyticsSelection = selectAnalyticsReceipts(allReceipts);
      const analyticsReceipts = analyticsSelection.analyticsReceipts;
      const homeReferenceNow = Date.now();
      let finalCompleteExperience: HomeProgressiveExperience;
      try {
        const [evaluation, productContext, personalInventory] = await Promise.all([
          evaluateCurrentEngagementMilestone(),
          loadEngagementProductInsightContext(),
          (async () => {
            try {
              const db = await getReceiptsDatabase();
              const inventoryResult =
                await loadPersonalProductEndpointInventoryWithDb(db);
              return inventoryResult.status === 'ready'
                ? inventoryResult.inventory
                : null;
            } catch (personalInventoryError) {
              logger.warn('Home', 'personal inventory enrichment skipped', {
                error: personalInventoryError,
              });
              return null;
            }
          })(),
        ]);
        finalCompleteExperience = buildHomeProgressiveExperience(
          analyticsReceipts,
          evaluation,
          false,
          productContext.rows,
          personalInventory,
          homeReferenceNow
        );
      } catch (analyticsError) {
        if (hadCompleteSnapshot) throw analyticsError;
        logger.warn('Home', 'progressive analytics failed', {
          error: analyticsError,
        });
        finalCompleteExperience = buildHomeProgressiveExperience(
          analyticsReceipts,
          null,
          true,
          [],
          null,
          homeReferenceNow
        );
      }
      if (
        !isLatestHomeRefresh(
          requestGeneration,
          refreshGenerationRef.current
        )
      ) {
        return;
      }
      setReceipts(allReceipts);
      setHomeExperience(finalCompleteExperience);
      hasCompleteSnapshotRef.current = true;
      setHomeRefreshState(completeHomeRefresh());
    } catch (e: any) {
      if (
        !isLatestHomeRefresh(
          requestGeneration,
          refreshGenerationRef.current
        )
      ) {
        return;
      }
      if (hasCompleteSnapshotRef.current) {
        logger.warn('Home', 'background refresh failed', { error: e });
      } else {
        console.error('加载收据失败:', e);
        setHomeExperience(buildHomeProgressiveExperience([], null, true));
      }
      setHomeRefreshState((state) => failHomeRefresh(state));
    }
  }, []);

  // 检测本地是否存在未完成的审核草稿/队列（脏数据会被自动修复）
  const refreshPendingReview = useCallback(async () => {
    try {
      const state = await getPendingScanReviewState();
      setPendingReview(state);
    } catch (e) {
      logger.warn('Home', 'refreshPendingReview failed', { error: e });
      setPendingReview({ nextDraftId: null, pendingCount: 0 });
    }
  }, []);

  // 当屏幕获得焦点时刷新数据（首次打开 + 从审核页返回都会触发）
  useFocusEffect(
    useCallback(() => {
      loadReceipts();
      void refreshPendingReview();
    }, [loadReceipts, refreshPendingReview])
  );

  // 点击“继续审核”：始终先刷新最新 pending 状态，再据此决定导航（点击时二次校验）
  const handleContinueReview = useCallback(async () => {
    if (scanning) return;
    const fresh = await getPendingScanReviewState();
    setPendingReview(fresh);
    if (fresh.nextDraftId) {
      router.push(`/scan-review/${fresh.nextDraftId}` as any);
    } else {
      Alert.alert(t('home.continueReviewMissingTitle'), t('home.continueReviewMissingMessage'));
    }
  }, [scanning, router]);


  // 扫描小票
  const handleScanReceipt = async () => {
    // Once-guard: 防止重复触发
    if (scanning) return;

    try {
      setScanning(true);

      // Network connectivity check (only in development)
      // Note: probe/ping failures are logged internally (once per session) to avoid spam
      if (__DEV__) {
        try {
          await probeSupabaseNetwork();
          await pingOcrEdge();
        } catch (pingError: any) {
          // Errors are already logged internally, only log unexpected errors here
          if (__DEV__ && pingError.message && !pingError.message.includes('not configured')) {
            console.warn('[OCR] Unexpected ping error:', pingError.message);
          }
        }
      }

      // 选择图片来源：拍照或相册
      const sourceChoice = await new Promise<'camera' | 'album' | 'cancel'>((resolve) => {
        Alert.alert(
          t('home.scan.title'),
          '',
          [
            { text: t('home.scan.cancel'), style: 'cancel', onPress: () => resolve('cancel') },
            { text: t('home.scan.takePhoto'), onPress: () => resolve('camera') },
            { text: t('home.scan.chooseFromLibrary'), onPress: () => resolve('album') },
          ],
          { cancelable: true, onDismiss: () => resolve('cancel') }
        );
      });

      if (sourceChoice === 'cancel') {
        setScanning(false);
        return;
      }

      if (sourceChoice === 'camera') {
            // 请求相机权限
            const { status: cameraStatus } = await ImagePicker.requestCameraPermissionsAsync();
            if (cameraStatus !== 'granted') {
              Alert.alert(t('permissions.cameraDeniedTitle'), t('permissions.cameraDeniedMessage'));
              setScanning(false);
              return;
            }

            // 拍照
            const cameraResult = await ImagePicker.launchCameraAsync({
              mediaTypes: 'images',
              quality: 1,
              allowsEditing: false,
            });

            if (cameraResult.canceled) {
              setScanning(false);
              return;
            }

            const uri = cameraResult.assets[0]?.uri;
            if (!uri) {
              setScanning(false);
              return;
            }

        // 确认识别对话框（包含隐私说明）
        const confirmResult = await new Promise<boolean>((resolve) => {
          Alert.alert(
            t('home.scan.confirmTitle'),
            `${t('home.scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`,
            [
              { text: t('home.scan.confirmCancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('home.scan.confirmAction'), onPress: () => resolve(true) },
            ]
          );
        });

            if (!confirmResult) {
              setScanning(false);
              return;
            }

        await processReceiptImage(uri);
      } else if (sourceChoice === 'album') {
        // 请求相册权限
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert(t('permissions.libraryDeniedTitle'), t('permissions.libraryDeniedMessage'));
          setScanning(false);
          return;
        }

        // 选择图片（启用多选）
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: 'images',
          quality: 1,
          allowsMultipleSelection: true,
          orderedSelection: true,
        });

        if (result.canceled) {
          setScanning(false);
          return;
        }

        const assets = result.assets || [];
        if (assets.length === 0) {
          setScanning(false);
          Alert.alert(t('home.scan.error'), t('home.scan.noImages'));
          return;
        }

        // 确认识别对话框（包含隐私说明）
        const confirmTitle = assets.length === 1
          ? t('home.scan.confirmTitle')
          : t('home.scan.confirmTitleMultiple', { count: assets.length });
        const confirmMessage = `${t('home.scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`;
        
        const confirmResult = await new Promise<boolean>((resolve) => {
          Alert.alert(
            confirmTitle,
            confirmMessage,
            [
              { text: t('home.scan.confirmCancel'), style: 'cancel', onPress: () => resolve(false) },
              { text: t('home.scan.confirmAction'), onPress: () => resolve(true) },
            ]
          );
        });

        if (!confirmResult) {
          setScanning(false);
          return;
        }

        // 处理多张图片（顺序处理）
        if (assets.length === 1) {
          // 单张图片，使用原有流程
          await processReceiptImage(assets[0].uri);
        } else {
          // 多张图片，顺序处理
          await processMultipleReceiptImages(assets.map(a => a.uri));
        }
      }
    } catch (err: any) {
      // 用户可见文案统一走 getScanErrorMessage（无 code 则回退 ocr.failed），技术细节仅进日志。
      logger.error('Home', 'Scan error', err);
      Alert.alert(t('home.scan.error'), getScanErrorMessage(err?.code || 'FAILED'));
      endScan();
    }
  };

  // 集中清理处理状态，所有失败/取消终点都应调用，避免按钮锁死或进度残留。
  const endScan = () => {
    setScanning(false);
    setProcessingProgress(null);
  };

  // 构造批量结果摘要：复用现有 doneSummary / failureReason* 文案。
  const buildBatchSummaryMessage = (successCount: number, failed: FailedScanItem[]): string => {
    const { failCount, failureReasonsByCode } = buildBatchFailureSummary(failed);
    const reasonParts = Object.entries(failureReasonsByCode)
      .map(([code, count]) => t('home.scan.failureReasonCount', { label: getScanErrorMessage(code), count }))
      .join('、');
    const reasonsLine = Object.keys(failureReasonsByCode).length > 0
      ? t('home.scan.failureReasonsPrefix') + reasonParts
      : '';
    return reasonsLine
      ? t('home.scan.doneSummaryWithReasons', { ok: successCount, fail: failCount, reasons: reasonsLine })
      : t('home.scan.doneSummary', { ok: successCount, fail: failCount });
  };

  // 顺序扫描一组 uris，更新进度，返回每张的结果（不抛错）。
  const runBatchScan = async (uris: string[]): Promise<ScanOneResult[]> => {
    const total = uris.length;
    const results: ScanOneResult[] = [];
    for (let i = 0; i < uris.length; i++) {
      setProcessingProgress({ current: i + 1, total });
      const result = await runScanPipelineToReview(uris[i]);
      results.push(result);
      if (!result.ok) {
        // 单张可恢复失败（如 OCR_TIMEOUT）：仅 warn，不触发 redbox；已成功的 draft 不受影响。
        logger.warn('MultiScan', `image ${i + 1}/${total} failed`, { code: result.code, message: result.message });
      }
    }
    setProcessingProgress(null);
    return results;
  };

  // 进入审核：把已成功 draftIds 写入队列并跳转第一张。失败 uri 永远不会进入此处。
  const continueWithDrafts = async (draftIds: string[]) => {
    await setScanReviewQueue(draftIds);
    endScan();
    router.push(`/scan-review/${draftIds[0]}` as any);
  };

  // 只重试失败图片：成功的追加到已有 draftIds 之后，已成功 draft 不重复清理。
  const retryFailedImages = (baseDraftIds: string[], failed: FailedScanItem[]) => {
    setScanning(true);
    void (async () => {
      try {
        const failedUris = failed.map((f) => f.uri);
        const results = await runBatchScan(failedUris);
        const draftIds = mergeDraftIdsAfterRetry(baseDraftIds, results);
        const stillFailed = collectFailedScanItems(failedUris, results);
        await finalizeBatchOutcome(failedUris, draftIds, stillFailed, true);
      } catch (err: any) {
        logger.error('MultiScan', 'retryFailedImages error', err);
        endScan();
        Alert.alert(t('home.scan.error'), getScanErrorMessage('FAILED'));
      }
    })();
  };

  // 重试全部：清空队列后对给定 uris 重新整批扫描。
  const retryAllImages = (uris: string[]) => {
    setScanning(true);
    void (async () => {
      try {
        await clearScanReviewQueue();
        const results = await runBatchScan(uris);
        const draftIds = mergeDraftIdsAfterRetry([], results);
        const failed = collectFailedScanItems(uris, results);
        await finalizeBatchOutcome(uris, draftIds, failed, true);
      } catch (err: any) {
        logger.error('MultiScan', 'retryAllImages error', err);
        endScan();
        Alert.alert(t('home.scan.error'), getScanErrorMessage('FAILED'));
      }
    })();
  };

  // 根据一次批量（或重试）结果决定下一步：全部成功 / 部分失败 / 全部失败。
  // retryUris 为本次涉及的图片集合（用于“重试全部”）；afterRetry 控制摘要前缀。
  const finalizeBatchOutcome = async (
    retryUris: string[],
    draftIds: string[],
    failed: FailedScanItem[],
    afterRetry: boolean
  ) => {
    // 全部成功：直接进入审核
    if (failed.length === 0 && draftIds.length > 0) {
      await continueWithDrafts(draftIds);
      return;
    }

    // 部分失败：保留已成功 draft，让用户选择继续或只重试失败图片
    if (draftIds.length > 0) {
      const prefix = afterRetry ? `${t('home.scan.partialRetryStillFailed')}\n\n` : '';
      const message = prefix + buildBatchSummaryMessage(draftIds.length, failed);
      endScan();
      Alert.alert(t('home.scan.partialTitle'), message, [
        {
          text: t('home.scan.continueSuccessful'),
          onPress: () => {
            void continueWithDrafts(draftIds);
          },
        },
        {
          text: t('home.scan.retryFailed'),
          onPress: () => retryFailedImages(draftIds, failed),
        },
      ]);
      return;
    }

    // 全部失败：可重试全部或取消
    const message = buildBatchSummaryMessage(0, failed);
    endScan();
    Alert.alert(t('home.scan.allFailedTitle'), message, [
      {
        text: t('home.scan.cancel'),
        style: 'cancel',
        onPress: () => {
          void clearScanReviewQueue();
          endScan();
        },
      },
      {
        text: t('home.scan.retryAll'),
        onPress: () => retryAllImages(retryUris),
      },
    ]);
  };

  // 处理多张收据：逐张识别进审核草稿队列，再进入第一张审核页
  const processMultipleReceiptImages = async (uris: string[]) => {
    try {
      await clearScanReviewQueue();
      const results = await runBatchScan(uris);
      const draftIds = mergeDraftIdsAfterRetry([], results);
      const failed = collectFailedScanItems(uris, results);
      await finalizeBatchOutcome(uris, draftIds, failed, false);
    } catch (err: any) {
      logger.error('MultiScan', 'Unexpected error', err);
      endScan();
      Alert.alert(t('home.scan.error'), getScanErrorMessage('FAILED'));
    }
  };

  // 处理单张收据：OCR → 分类 → 审核页；失败时允许重试同一张图片（仅用户手动触发）
  const processReceiptImage = async (uri: string) => {
    const t0 = Date.now();
    if (__DEV__) {
      console.log('[ScanTiming] ui_start_ms', { t0 });
    }

    const result = await runScanPipelineToReview(uri);
    if (!result.ok) {
      const code = result.code || 'FAILED';
      // 可恢复失败（OCR_TIMEOUT 等）：warn + 重试 Alert，不触发 redbox。
      logger.warn('Scan', 'single scan failed', { code, message: result.message });
      // 失败：先恢复状态再弹重试 Alert，避免卡在处理中
      endScan();
      Alert.alert(
        t('home.scan.error'),
        `${getScanErrorMessage(code)}\n\n${t('home.scan.singleFailedMessage')}`,
        [
          { text: t('home.scan.cancel'), style: 'cancel' },
          {
            text: t('home.scan.retry'),
            onPress: () => {
              setScanning(true);
              void processReceiptImage(uri);
            },
          },
        ]
      );
      return;
    }

    if (result.kind !== 'review') {
      endScan();
      return;
    }

    await clearScanReviewQueue();
    await setScanReviewQueue([result.draftId]);
    endScan();
    if (__DEV__) {
      console.log('[ScanTiming] navigate_review_ms', { ms: Date.now() - t0 });
    }
    router.push(`/scan-review/${result.draftId}` as any);
  };

  // Calculate bottom padding for sticky button dynamically.
  // Always keep the last Progressive Home card clear of the bottom tab bar.
  // stickyHeight is measured via onLayout and includes the container's padding.
  const FALLBACK_STICKY_HEIGHT = 88; // Conservative estimate: button (~48) + padding (40)
  const TAB_BAR_CONTENT_CLEARANCE = UI_LAYOUT.tabContentClearance;
  const bottomPadding =
    pendingReview.pendingCount > 0
      ? (stickyHeight || FALLBACK_STICKY_HEIGHT) + 16
      : TAB_BAR_CONTENT_CLEARANCE + Math.max(insets.bottom, 0);
  const handleRecentPurchasePress = useCallback(
    (receiptId: string) => {
      router.push(`/history/${encodeURIComponent(receiptId)}` as any);
    },
    [router]
  );
  const handleProductPress = useCallback(
    (product: MilestoneFrequentProduct) => {
      const href = buildHomeFrequentProductDetailHref(product);
      if (!href) return;
      router.push(href as any);
    },
    [router]
  );
  const handleNextPurchasePress = useCallback(
    (candidate: {
      identityKind: MilestoneFrequentProduct['groupingType'];
      identityKey: string;
    }) => {
      const href = buildHomeFrequentProductDetailHref({
        groupingType: candidate.identityKind,
        key: candidate.identityKey,
      });
      if (!href) return;
      router.push(href as any);
    },
    [router]
  );

  return (
    <View
      style={[
        styles.screenContainer,
        { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap },
      ]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingBottom: bottomPadding },
        ]}
      >
        <ProgressiveHomeInsights
          experience={homeExperience}
          initialLoading={
            homeRefreshState.initialLoading &&
            !homeRefreshState.hasCompleteSnapshot
          }
          scanning={scanning}
          processingProgress={processingProgress}
          onScan={handleScanReceipt}
          onRecentPurchasePress={handleRecentPurchasePress}
          onProductPress={handleProductPress}
          onNextPurchasePress={handleNextPurchasePress}
        />
      </ScrollView>

      {pendingReview.pendingCount > 0 && pendingReview.nextDraftId && (
        <View
          style={[
            styles.stickyButtonContainer,
            { paddingBottom: insets.bottom + 12 },
          ]}
          onLayout={(e) => setStickyHeight(e.nativeEvent.layout.height)}
        >
          <Pressable
            style={[styles.continueReviewCard, scanning && styles.scanButtonDisabled]}
            onPress={handleContinueReview}
            disabled={scanning}
          >
            <View style={styles.continueReviewTextWrap}>
              <Text style={styles.continueReviewTitle} numberOfLines={1}>
                {t('home.continueReviewTitle')}
              </Text>
              <Text style={styles.continueReviewSubtitle} numberOfLines={1}>
                {t('home.continueReviewSubtitle', { count: pendingReview.pendingCount })}
              </Text>
            </View>
            <View style={styles.continueReviewBtn}>
              <Text style={styles.continueReviewBtnText}>{t('home.continueReviewButton')}</Text>
            </View>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  container: {
    paddingTop: 0,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingBottom: 40,
  },
  title: {
    fontSize: UI_TYPOGRAPHY.pageTitle,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#555',
  },
  categoryList: {
    marginTop: 20,
    paddingHorizontal: 12,
  },
  categoryListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.border,
  },
  categoryDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 12,
  },
  categoryName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#333',
  },
  categoryAmount: {
    fontSize: 14,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
    marginRight: 12,
    minWidth: 80,
    textAlign: 'right',
  },
  categoryPercentage: {
    fontSize: 14,
    fontWeight: '700',
    color: UI_COLORS.textSecondary,
    minWidth: 50,
    textAlign: 'right',
  },
  advancedInsightContainer: {
    marginTop: 20,
    paddingHorizontal: 12,
  },
  advancedInsightRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
    padding: 12,
  },
  insightBadge: {
    width: 20,
    height: 20,
    borderRadius: UI_RADIUS.control,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    flexShrink: 0,
  },
  insightBadgeAlert: {
    backgroundColor: '#ff4444',
  },
  insightBadgeWarn: {
    backgroundColor: '#ff8800',
  },
  insightBadgeInfo: {
    backgroundColor: '#4488ff',
  },
  insightBadgeText: {
    fontSize: 12,
    fontWeight: '900',
    color: UI_COLORS.background,
  },
  advancedInsightText: {
    flex: 1,
    fontSize: 13,
    color: '#333',
    lineHeight: 18,
  },
  emptyState: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 16,
    color: '#999',
  },
  kpiCard: {
    backgroundColor: '#f8f8f8',
    borderRadius: UI_RADIUS.card,
    padding: 16,
    marginTop: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: UI_COLORS.border,
  },
  kpiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  kpiItem: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  kpiLabel: {
    fontSize: 12,
    color: UI_COLORS.textSecondary,
    marginBottom: 4,
    fontWeight: '600',
  },
  kpiValue: {
    fontSize: 16,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
    textAlign: 'center',
  },
  kpiSubValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#444',
    marginTop: 2,
    textAlign: 'center',
  },
  uncategorizedHint: {
    fontSize: 12,
    color: UI_COLORS.textSecondary,
  },
  insightAnalysisContainer: {
    marginTop: 20,
    paddingHorizontal: 12,
    backgroundColor: '#f8f8f8',
    borderRadius: UI_RADIUS.card,
    padding: 16,
    borderWidth: 1,
    borderColor: UI_COLORS.border,
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  insightHeadline: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
    marginLeft: 8,
  },
  insightReasons: {
    marginBottom: 12,
  },
  insightReasonText: {
    fontSize: 13,
    color: '#555',
    lineHeight: 20,
    marginBottom: 4,
  },
  insightSuggestion: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: UI_COLORS.border,
  },
  insightSuggestionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
    marginBottom: 4,
  },
  insightSuggestionText: {
    fontSize: 14,
    color: UI_COLORS.textPrimary,
    fontWeight: '600',
    lineHeight: 20,
  },
  stickyButtonContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: UI_COLORS.background,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingTop: 10,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderTopColor: UI_COLORS.border,
    ...UI_SHADOW.sticky,
  },
  continueReviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f6ff',
    borderWidth: 1,
    borderColor: '#d4e4fb',
    borderRadius: UI_RADIUS.panel,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  continueReviewTextWrap: {
    flex: 1,
    marginRight: 12,
  },
  continueReviewTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1f3655',
  },
  continueReviewSubtitle: {
    fontSize: 13,
    color: '#61738b',
    marginTop: 2,
  },
  continueReviewBtn: {
    backgroundColor: UI_COLORS.accent,
    borderRadius: UI_RADIUS.control,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  continueReviewBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: UI_COLORS.background,
  },
  scanButton: {
    backgroundColor: UI_COLORS.textPrimary,
    borderRadius: UI_RADIUS.card,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButtonDisabled: {
    opacity: 0.6,
  },
  scanButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: UI_COLORS.background,
  },
});
