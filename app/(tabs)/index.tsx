// app/(tabs)/index.tsx

import { useFocusEffect } from '@react-navigation/native';
import { usePathname, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useReceiptScanLauncher } from '@/hooks/useReceiptScanLauncher';
import {
  getPendingScanReviewState,
  type PendingScanReviewState,
} from '@/lib/scanReviewQueue';
import { logger } from '@/lib/logger';

import { selectAnalyticsReceiptsCached } from '@/lib/analyticsReceiptSelectionCache';
import {
  listReceipts,
  getReceiptsDatabase,
  initIfNeeded,
  isOwnerScopedReceiptReadUnavailableError,
  type ReceiptRow,
} from '@/lib/db';
import {
  evaluateCurrentEngagementMilestone,
  loadEngagementOwnerReceiptsWithDb,
  loadEngagementProductInsightContext,
  loadEngagementProductInsightContextWithDb,
  type EngagementPreloadedAnalyticsContext,
  type MilestoneFrequentProduct,
} from '@/lib/engagementMilestones';
import {
  buildHomeProgressiveExperience,
  buildHomeProgressiveExperienceBundle,
  refreshHomeNextPurchaseFromProfiles,
  type HomeProgressiveExperience,
} from '@/lib/homeProgressiveExperience';
import {
  commitHomeFocusHeavySnapshot,
  tryReuseHomeFocusHeavySnapshot,
} from '@/lib/homeFocusHeavySnapshot';
import {
  readTabFocusDataGenerations,
  shouldApplyHomeHeavyReuseResult,
  shouldBlessHomeHeavySnapshot,
  tabFocusDataGenerationsEqual,
} from '@/lib/tabFocusDataGenerations';
import { loadPersonalProductEndpointInventoryWithDb } from '@/lib/personalProductEndpointInventory';
import { resolveCurrentLocalReceiptOwnerScope } from '@/lib/receiptOwnershipScope';
import {
  beginHomeRefresh,
  completeHomeRefresh,
  failHomeRefresh,
  holdHomeRefreshForRetry,
  INITIAL_HOME_REFRESH_STATE,
  isLatestHomeRefresh,
} from '@/lib/homeRefreshState';
import { createHomeRefreshCoordinator } from '@/lib/homeRefreshCoordinator';
import {
  beginHomeRefreshTimingCapture,
  logHomeRefreshCoordinatorEvent,
  measureHomeRefreshStage,
  recordHomeRefreshTiming,
} from '@/lib/homeRefreshTimings';
import { recordDiagnosticEvent } from '@/lib/internalDiagnostics';
import { isHomeRoutePath } from '@/lib/homeRouteVisibility';
import { runHomeShoppingListRefresh } from '@/lib/homeShoppingListRefresh';
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
import {
  addShoppingListItemFromNextPurchase,
  listShoppingListItems,
} from '@/lib/shoppingList';
import type { NextPurchaseCandidate } from '@/lib/nextPurchaseCandidates';
import type { RepeatProductProfile } from '@/lib/repeatProductProfile';
// 商品分类由 receiptEnricher.applyCategoriesWithLearning 完成（规则 + classify-item AI + 学习表），在 lib/scanPipeline 内调用
export default function HomeScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [homeRefreshState, setHomeRefreshState] = useState(
    INITIAL_HOME_REFRESH_STATE
  );
  const hasCompleteSnapshotRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const shoppingListRefreshGenerationRef = useRef(0);
  const coldStartRetryUsedRef = useRef(false);
  const homeWasVisibleRef = useRef(false);
  const [homeExperience, setHomeExperience] =
    useState<HomeProgressiveExperience>(() =>
      buildHomeProgressiveExperience([], null)
    );
  const {
    launchReceiptScan,
    isScanning: scanning,
    processingProgress,
  } = useReceiptScanLauncher();
  const [stickyHeight, setStickyHeight] = useState(0);
  const [pendingReview, setPendingReview] = useState<PendingScanReviewState>({
    nextDraftId: null,
    pendingCount: 0,
  });
  const [shoppingListIncompleteCount, setShoppingListIncompleteCount] =
    useState(0);
  const [activeShoppingListIdentities, setActiveShoppingListIdentities] =
    useState<ReadonlySet<string>>(() => new Set());
  const [activeShoppingListQuantities, setActiveShoppingListQuantities] =
    useState<ReadonlyMap<string, number>>(() => new Map());


  const canApplyHomeUi = useCallback(
    (options?: { canApply?: () => boolean }) =>
      options?.canApply == null || options.canApply(),
    []
  );

  // 加载所有收据； progressive analytics 使用去重后的 purchase candidates
  const loadReceipts = useCallback(
    async (options?: {
      isAutomaticRetry?: boolean;
      canApply?: () => boolean;
    }) => {
      if (!canApplyHomeUi(options)) {
        return;
      }
      const requestGeneration = ++refreshGenerationRef.current;
      const hadCompleteSnapshot = hasCompleteSnapshotRef.current;
      setHomeRefreshState((state) => beginHomeRefresh(state));
      beginHomeRefreshTimingCapture();
      const totalStarted = Date.now();
      try {
        const generationCheckStarted = Date.now();
        // REQUIRED: resolve owner before snapshot hit (never generation-only).
        const reuseOwnerScope = await resolveCurrentLocalReceiptOwnerScope();
        let reuseOwnerKey =
          reuseOwnerScope.status === 'ready' ? reuseOwnerScope.ownerKey : '';
        let startGenerations = readTabFocusDataGenerations();
        const reusable = tryReuseHomeFocusHeavySnapshot(reuseOwnerKey);
        recordHomeRefreshTiming({
          stage: 'focusGenerationCheck',
          durationMs: Date.now() - generationCheckStarted,
        });
        if (reusable) {
          const reuseStarted = Date.now();
          const projected = await measureHomeRefreshStage(
            'timeProjection',
            () =>
              refreshHomeNextPurchaseFromProfiles(
                reusable.experience,
                reusable.repeatProfiles,
                Date.now()
              )
          );
          // Post-await re-check: owner + generations may have drifted during await.
          const postOwnerScope = await resolveCurrentLocalReceiptOwnerScope();
          const postOwnerKey =
            postOwnerScope.status === 'ready' ? postOwnerScope.ownerKey : '';
          const postGenerations = readTabFocusDataGenerations();
          const requestStillLatest = isLatestHomeRefresh(
            requestGeneration,
            refreshGenerationRef.current
          );
          const canApply = canApplyHomeUi(options);
          if (
            !shouldApplyHomeHeavyReuseResult({
              snapshotOwnerKey: reusable.ownerKey,
              snapshotGenerations: reusable.generations,
              currentOwnerKey: postOwnerKey,
              currentGenerations: postGenerations,
              requestStillLatest,
              canApply,
            })
          ) {
            // Superseded / not visible → discard only. Still-latest drift →
            // abandon reuse and fall through to a fresh heavy rebuild.
            if (!requestStillLatest || !canApply) {
              recordHomeRefreshTiming({
                stage: 'total',
                durationMs: Date.now() - totalStarted,
              });
              return;
            }
            reuseOwnerKey = postOwnerKey;
            startGenerations = postGenerations;
          } else {
            setReceipts(reusable.displayReceipts);
            setHomeExperience(projected);
            hasCompleteSnapshotRef.current = true;
            setHomeRefreshState(completeHomeRefresh());
            recordHomeRefreshTiming({
              stage: 'heavySnapshotReuse',
              durationMs: Date.now() - reuseStarted,
              receiptCount: reusable.displayReceipts.length,
            });
            recordHomeRefreshTiming({
              stage: 'total',
              durationMs: Date.now() - totalStarted,
            });
            return;
          }
        }

        const allReceipts = await measureHomeRefreshStage('listReceipts', () =>
          listReceipts()
        );
        if (
          !isLatestHomeRefresh(
            requestGeneration,
            refreshGenerationRef.current
          ) ||
          !canApplyHomeUi(options)
        ) {
          recordHomeRefreshTiming({
            stage: 'total',
            durationMs: Date.now() - totalStarted,
          });
          return;
        }

        const ownerScope = await resolveCurrentLocalReceiptOwnerScope();
        const ownerKey =
          ownerScope.status === 'ready' ? ownerScope.ownerKey : '';

        // Display slice (newest 200) selection — independent of engagement universe.
        const displaySelectStarted = Date.now();
        const displaySelection = selectAnalyticsReceiptsCached({
          ownerKey: ownerKey || 'anonymous',
          receipts: allReceipts,
          shouldSkipExpensiveBuild: () =>
            !isLatestHomeRefresh(
              requestGeneration,
              refreshGenerationRef.current
            ) || !canApplyHomeUi(options),
        });
        if (!displaySelection) {
          recordHomeRefreshTiming({
            stage: 'total',
            durationMs: Date.now() - totalStarted,
          });
          return;
        }
        const analyticsReceipts = displaySelection.analyticsReceipts;
        recordHomeRefreshTiming({
          stage: 'selectAnalyticsReceipts',
          durationMs: Date.now() - displaySelectStarted,
          receiptCount: allReceipts.length,
          analyticsReceiptCount: analyticsReceipts.length,
        });
        if (
          !isLatestHomeRefresh(
            requestGeneration,
            refreshGenerationRef.current
          ) ||
          !canApplyHomeUi(options)
        ) {
          return;
        }

        // Full-history engagement universe (one load + one decision + shared JOIN).
        let preloaded: EngagementPreloadedAnalyticsContext | undefined;
        /** Full-history analytics receipts for Repeat / Next Purchase (not display-200). */
        let longTermAnalyticsReceipts: ReceiptRow[] | undefined;
        if (ownerScope.status === 'ready') {
          const db = await getReceiptsDatabase();
          const engagementReceipts = await measureHomeRefreshStage(
            'engagementReceiptLoad',
            () => loadEngagementOwnerReceiptsWithDb(db, ownerScope)
          );
          if (
            !isLatestHomeRefresh(
              requestGeneration,
              refreshGenerationRef.current
            ) ||
            !canApplyHomeUi(options)
          ) {
            return;
          }
          const engagementSelectStarted = Date.now();
          const engagementSelection = selectAnalyticsReceiptsCached({
            ownerKey: ownerScope.ownerKey,
            receipts: engagementReceipts as ReceiptRow[],
            shouldSkipExpensiveBuild: () =>
              !isLatestHomeRefresh(
                requestGeneration,
                refreshGenerationRef.current
              ) || !canApplyHomeUi(options),
          });
          if (!engagementSelection) {
            return;
          }
          recordHomeRefreshTiming({
            stage: 'selectAnalyticsReceipts',
            durationMs: Date.now() - engagementSelectStarted,
            receiptCount: engagementReceipts.length,
            analyticsReceiptCount: engagementSelection.analyticsReceipts.length,
          });
          longTermAnalyticsReceipts =
            engagementSelection.analyticsReceipts as ReceiptRow[];
          preloaded = {
            ownerKey: ownerScope.ownerKey,
            receipts: engagementReceipts,
            analyticsReceipts:
              engagementSelection.analyticsReceipts as EngagementPreloadedAnalyticsContext['analyticsReceipts'],
            excludedDuplicateReceiptIds:
              engagementSelection.excludedDuplicateReceiptIds,
            precomputedSelection: true,
          };
          logger.info(
            'HomePerf',
            `engagement precomputedSelection=true fullHistoryCount=${engagementReceipts.length} displayCount=${allReceipts.length} analyticsCount=${engagementSelection.analyticsReceipts.length}`
          );
          const sharedProductInsight = (async () => {
            return loadEngagementProductInsightContextWithDb(db, {
              preloaded: {
                ...preloaded!,
                sharedProductInsight: undefined,
              },
            });
          })();
          preloaded.sharedProductInsight = sharedProductInsight;
        }

        const homeReferenceNow = Date.now();

        let finalCompleteExperience: HomeProgressiveExperience;
        let heavyRepeatProfiles: readonly RepeatProductProfile[] = [];
        let progressiveAnalyticsSucceeded = true;
        try {
          const [evaluation, productContext, personalInventory] =
            await Promise.all([
              measureHomeRefreshStage('engagementMilestone', () =>
                evaluateCurrentEngagementMilestone({ preloaded })
              ),
              measureHomeRefreshStage('productContext', () =>
                loadEngagementProductInsightContext({ preloaded })
              ),
              measureHomeRefreshStage('personalInventory', async () => {
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
              }),
            ]);
          if (
            !isLatestHomeRefresh(
              requestGeneration,
              refreshGenerationRef.current
            ) ||
            !canApplyHomeUi(options)
          ) {
            return;
          }
          finalCompleteExperience = await measureHomeRefreshStage(
            'buildHomeProgressiveExperience',
            () => {
              const bundle = buildHomeProgressiveExperienceBundle(
                analyticsReceipts,
                evaluation,
                false,
                productContext.rows,
                personalInventory,
                homeReferenceNow,
                longTermAnalyticsReceipts
              );
              heavyRepeatProfiles = bundle.repeatProfiles;
              return bundle.experience;
            },
            {
              receiptCount: allReceipts.length,
              analyticsReceiptCount: analyticsReceipts.length,
              productRowCount: productContext.rows.length,
            }
          );
        } catch (analyticsError) {
          if (hadCompleteSnapshot) throw analyticsError;
          // Displayable fallback only — do NOT bless this generation as
          // successful heavy truth (no snapshot commit / complete marker).
          progressiveAnalyticsSucceeded = false;
          logger.warn('Home', 'progressive analytics failed', {
            error: analyticsError,
          });
          const fallback = buildHomeProgressiveExperienceBundle(
            analyticsReceipts,
            null,
            true,
            [],
            null,
            homeReferenceNow
          );
          finalCompleteExperience = fallback.experience;
          heavyRepeatProfiles = fallback.repeatProfiles;
        }
        if (
          !isLatestHomeRefresh(
            requestGeneration,
            refreshGenerationRef.current
          ) ||
          !canApplyHomeUi(options)
        ) {
          return;
        }
        const liveOwnerScope = await resolveCurrentLocalReceiptOwnerScope();
        const liveOwnerKey =
          liveOwnerScope.status === 'ready' ? liveOwnerScope.ownerKey : '';
        const endGenerations = readTabFocusDataGenerations();
        // A2: after FINAL await, recompute real request/visibility — never hardcode true.
        const requestStillLatest = isLatestHomeRefresh(
          requestGeneration,
          refreshGenerationRef.current
        );
        const canApply = canApplyHomeUi(options);
        if (
          !shouldApplyHomeHeavyReuseResult({
            snapshotOwnerKey: reuseOwnerKey,
            snapshotGenerations: startGenerations,
            currentOwnerKey: liveOwnerKey,
            currentGenerations: endGenerations,
            requestStillLatest,
            canApply,
          })
        ) {
          return;
        }
        setReceipts(allReceipts);
        setHomeExperience(finalCompleteExperience);
        setHomeRefreshState(completeHomeRefresh());
        if (
          shouldBlessHomeHeavySnapshot({
            progressiveAnalyticsSucceeded,
          })
        ) {
          hasCompleteSnapshotRef.current = true;
          commitHomeFocusHeavySnapshot({
            ownerKey: liveOwnerKey,
            startGenerations,
            displayReceipts: allReceipts,
            experience: finalCompleteExperience,
            repeatProfiles: heavyRepeatProfiles,
          });
        }
      } catch (e: any) {
        if (
          !isLatestHomeRefresh(
            requestGeneration,
            refreshGenerationRef.current
          ) ||
          !canApplyHomeUi(options)
        ) {
          return;
        }
        if (hasCompleteSnapshotRef.current) {
          logger.warn('Home', 'background refresh failed', { error: e });
          setHomeRefreshState((state) => failHomeRefresh(state));
          return;
        }

        console.error('加载收据失败:', e);

        // Cold start: one readiness retry after DB init, then terminal empty/error.
        if (!options?.isAutomaticRetry && !coldStartRetryUsedRef.current) {
          coldStartRetryUsedRef.current = true;
          setHomeRefreshState(holdHomeRefreshForRetry());
          try {
            await initIfNeeded();
            await getReceiptsDatabase();
          } catch (initError) {
            logger.warn('Home', 'cold-start DB readiness failed', {
              error: initError,
            });
            if (!canApplyHomeUi(options)) return;
            setHomeExperience(buildHomeProgressiveExperience([], null, true));
            setHomeRefreshState((state) => failHomeRefresh(state));
            return;
          }
          if (
            !isLatestHomeRefresh(
              requestGeneration,
              refreshGenerationRef.current
            ) ||
            !canApplyHomeUi(options)
          ) {
            return;
          }
          await loadReceipts({
            isAutomaticRetry: true,
            canApply: options?.canApply,
          });
          return;
        }

        // Transient owner truth: never mark authoritative empty snapshot.
        if (isOwnerScopedReceiptReadUnavailableError(e)) {
          logger.warn('Home', 'owner-scoped read unavailable', { error: e });
          setHomeRefreshState((state) => failHomeRefresh(state));
          return;
        }

        setHomeExperience(buildHomeProgressiveExperience([], null, true));
        setHomeRefreshState((state) => failHomeRefresh(state));
      } finally {
        recordHomeRefreshTiming({
          stage: 'total',
          durationMs: Date.now() - totalStarted,
        });
      }
    },
    [canApplyHomeUi]
  );

  // 检测本地是否存在未完成的审核草稿/队列（脏数据会被自动修复）
  const refreshPendingReview = useCallback(
    async (options?: { canApply?: () => boolean }) => {
      try {
        const state = await getPendingScanReviewState();
        if (!canApplyHomeUi(options)) return;
        setPendingReview(state);
      } catch (e) {
        logger.warn('Home', 'refreshPendingReview failed', { error: e });
        if (!canApplyHomeUi(options)) return;
        setPendingReview({ nextDraftId: null, pendingCount: 0 });
      }
    },
    [canApplyHomeUi]
  );

  const refreshShoppingListHomeState = useCallback(
    async (options?: { canApply?: () => boolean }) => {
      await runHomeShoppingListRefresh({
        generationRef: shoppingListRefreshGenerationRef,
        loadItems: listShoppingListItems,
        apply: (derived) => {
          if (!canApplyHomeUi(options)) return;
          setShoppingListIncompleteCount(derived.incompleteCount);
          setActiveShoppingListIdentities(derived.activeIdentities);
          setActiveShoppingListQuantities(derived.activeQuantities);
        },
        onError: (error) => {
          logger.warn('Home', 'shopping list home state refresh failed', {
            error,
          });
        },
      });
    },
    [canApplyHomeUi]
  );

  const refreshHomeWhenVisible = useCallback(
    async (ctx: { canApply: () => boolean }) => {
      const applyOptions = { canApply: ctx.canApply };
      const volatileStarted = Date.now();
      await Promise.all([
        loadReceipts(applyOptions),
        refreshPendingReview(applyOptions),
        refreshShoppingListHomeState(applyOptions),
      ]);
      recordHomeRefreshTiming({
        stage: 'volatileRefresh',
        durationMs: Date.now() - volatileStarted,
      });
    },
    [loadReceipts, refreshPendingReview, refreshShoppingListHomeState]
  );

  const refreshHomeImplRef = useRef(refreshHomeWhenVisible);
  refreshHomeImplRef.current = refreshHomeWhenVisible;

  const createHomeCoordinator = useCallback(
    () =>
      createHomeRefreshCoordinator({
        runRefresh: (ctx) => refreshHomeImplRef.current(ctx),
        onEvent: logHomeRefreshCoordinatorEvent,
      }),
    []
  );

  const homeRefreshCoordinatorRef = useRef(createHomeCoordinator());

  const ensureHomeCoordinator = useCallback(() => {
    if (
      !homeRefreshCoordinatorRef.current ||
      homeRefreshCoordinatorRef.current.isDisposed()
    ) {
      homeRefreshCoordinatorRef.current = createHomeCoordinator();
    }
    return homeRefreshCoordinatorRef.current;
  }, [createHomeCoordinator]);

  useEffect(() => {
    const coordinator = ensureHomeCoordinator();
    return () => {
      coordinator.dispose();
    };
  }, [ensureHomeCoordinator]);

  // Tab-level focus (History/Analysis ↔ Home, first mount).
  useFocusEffect(
    useCallback(() => {
      recordDiagnosticEvent({
        category: 'lifecycle',
        name: 'focus',
        screen: 'home',
      });
      const coordinator = ensureHomeCoordinator();
      const trigger = hasCompleteSnapshotRef.current ? 'focus' : 'cold';
      coordinator.requestVisibleRefresh(trigger);
      return () => {
        recordDiagnosticEvent({
          category: 'lifecycle',
          name: 'blur',
          screen: 'home',
        });
      };
    }, [ensureHomeCoordinator])
  );

  // Root-stack visibility: /shopping-list and /product/* return to Home without
  // always re-firing tab useFocusEffect — pathname becoming Home is authoritative.
  // Same visibility epoch coalesces focus+pathname even if pathname arrives after
  // the heavy run has already started (no trailing for visibility duplicates).
  useEffect(() => {
    const coordinator = ensureHomeCoordinator();
    const visible = isHomeRoutePath(pathname);
    if (visible && !homeWasVisibleRef.current) {
      recordDiagnosticEvent({
        category: 'lifecycle',
        name: 'visible',
        screen: 'home',
        meta: { via: 'pathname' },
      });
      coordinator.requestVisibleRefresh('pathname');
    } else if (!visible && homeWasVisibleRef.current) {
      recordDiagnosticEvent({
        category: 'lifecycle',
        name: 'hidden',
        screen: 'home',
        meta: { via: 'pathname' },
      });
      coordinator.markHomeHidden();
    }
    homeWasVisibleRef.current = visible;
  }, [pathname, ensureHomeCoordinator]);

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

  const handleShoppingListPress = useCallback(() => {
    router.push('/shopping-list' as any);
  }, [router]);

  const handleAddNextPurchaseToShoppingList = useCallback(
    async (candidate: NextPurchaseCandidate) => {
      try {
        const result = await addShoppingListItemFromNextPurchase(candidate);
        if (
          result.status === 'created' ||
          result.status === 'incremented' ||
          result.status === 'max_reached'
        ) {
          await refreshShoppingListHomeState();
        }
      } catch (error) {
        logger.warn('Home', 'add next purchase to shopping list failed', {
          error,
        });
      }
    },
    [refreshShoppingListHomeState]
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
          onScan={launchReceiptScan}
          onRecentPurchasePress={handleRecentPurchasePress}
          onProductPress={handleProductPress}
          onNextPurchasePress={handleNextPurchasePress}
          shoppingListIncompleteCount={shoppingListIncompleteCount}
          activeShoppingListIdentities={activeShoppingListIdentities}
          activeShoppingListQuantities={activeShoppingListQuantities}
          onShoppingListPress={handleShoppingListPress}
          onAddNextPurchaseToShoppingList={handleAddNextPurchaseToShoppingList}
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
