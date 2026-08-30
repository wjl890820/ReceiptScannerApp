import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MilestoneProgress } from '@/components/MilestoneProgress';
import { MilestoneUnlockCard } from '@/components/MilestoneUnlockCard';
import { PostSavePurchaseMemoryCard } from '@/components/PostSavePurchaseMemoryCard';
import {
  PersonalIdentityFeedbackCard,
  PersonalIdentityPromptCard,
} from '@/components/PersonalIdentityPromptCard';
import { getCategoryLabel } from '@/lib/categoryPalette';
import { getReceipt, getReceiptsDatabase } from '@/lib/db';
import { getCurrentLocale } from '@/lib/i18n';
import {
  confirmPersonalIdentityCandidateWithDb,
  type PersonalIdentityConfirmationChoice,
  type PersonalIdentityConfirmationFeedback,
} from '@/lib/personalProductIdentityConfirmationCoordinator';
import {
  findPersonalIdentityPromptCandidateForSavedReceipt,
  type PersonalIdentityPromptCandidateV1,
} from '@/lib/personalProductIdentityCandidateService';
import {
  buildReceiptShoppingSummary,
  evaluateSavedReceiptMilestone,
  type EngagementMilestoneEvaluation,
  type ReceiptShoppingSummary,
} from '@/lib/engagementMilestones';
import { formatDate } from '@/lib/formatDate';
import { formatJPY } from '@/lib/formatJPY';
import { t } from '@/lib/i18n';
import { isV1SupportedReceipt } from '@/lib/merchantType';
import { buildPostSaveMilestoneViewModel } from '@/lib/milestonePresentation';
import {
  getPostSavePrimaryDestination,
  parsePostSaveSummaryRouteContext,
} from '@/lib/postSaveSummaryNavigation';
import {
  loadPostSavePurchaseMemoryWithDb,
  type PostSavePurchaseMemory,
} from '@/lib/postSavePurchaseMemory';
import { shouldLoadPostSavePurchaseMemory } from '@/lib/postSaveSummaryProductSurface';
import { shouldApplyPostSaveIdentityUpdate } from '@/lib/postSaveSummaryIdentityLifecycle';
import type { ProductCategory } from '@/lib/productCategory';

function formatAmount(amount: number, currency: string): string {
  return currency === 'JPY'
    ? formatJPY(amount)
    : `${currency} ${amount.toLocaleString()}`;
}

export default function PostSaveSummaryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    receiptId?: string | string[];
    nextDraftId?: string | string[];
  }>();
  const routeContext = useMemo(
    () =>
      parsePostSaveSummaryRouteContext(
        params.receiptId,
        params.nextDraftId
      ),
    [params.nextDraftId, params.receiptId]
  );
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<ReceiptShoppingSummary | null>(null);
  const [supported, setSupported] = useState(false);
  const [evaluation, setEvaluation] =
    useState<EngagementMilestoneEvaluation | null>(null);
  const [identityCandidate, setIdentityCandidate] =
    useState<PersonalIdentityPromptCandidateV1 | null>(null);
  const [identityCandidateLoading, setIdentityCandidateLoading] = useState(false);
  const [identityChoiceProcessing, setIdentityChoiceProcessing] =
    useState<PersonalIdentityConfirmationChoice | null>(null);
  const [identityConfirmationError, setIdentityConfirmationError] =
    useState(false);
  const [identityFeedback, setIdentityFeedback] =
    useState<PersonalIdentityConfirmationFeedback | null>(null);
  const [purchaseMemory, setPurchaseMemory] =
    useState<PostSavePurchaseMemory | null>(null);
  const [purchaseMemoryLoading, setPurchaseMemoryLoading] = useState(false);
  const locale = getCurrentLocale();
  const identityGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      identityGenerationRef.current += 1;
    };
  }, []);

  const identityUpdateAllowed = (
    generation: number,
    receiptId: string | null | undefined
  ) =>
    shouldApplyPostSaveIdentityUpdate({
      mounted: mountedRef.current,
      capturedGeneration: generation,
      currentGeneration: identityGenerationRef.current,
      capturedReceiptId: receiptId ?? null,
      currentReceiptId: routeContext?.receiptId ?? null,
    });

  useEffect(() => {
    identityGenerationRef.current += 1;
    setIdentityCandidate(null);
    setIdentityCandidateLoading(false);
    setIdentityChoiceProcessing(null);
    setIdentityConfirmationError(false);
    setIdentityFeedback(null);
    setPurchaseMemory(null);
    setPurchaseMemoryLoading(false);
  }, [routeContext?.receiptId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSummary(null);
    setSupported(false);
    setEvaluation(null);
    setIdentityCandidate(null);
    setIdentityCandidateLoading(false);
    setIdentityChoiceProcessing(null);
    setIdentityConfirmationError(false);
    setIdentityFeedback(null);
    if (!routeContext) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    void Promise.allSettled([
      getReceipt(routeContext.receiptId),
      evaluateSavedReceiptMilestone(routeContext.receiptId),
    ]).then(([receiptResult, milestoneResult]) => {
      if (!active) return;
      if (receiptResult.status === 'fulfilled' && receiptResult.value) {
        try {
          setSummary(buildReceiptShoppingSummary(receiptResult.value));
          setSupported(isV1SupportedReceipt(receiptResult.value));
        } catch {
          // Receipt is already saved; summary data is best-effort only.
        }
      }
      if (milestoneResult.status === 'fulfilled') {
        setEvaluation(milestoneResult.value);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [routeContext]);

  useEffect(() => {
    const generation = identityGenerationRef.current;
    const receiptId = routeContext?.receiptId;
    if (!receiptId || identityFeedback) {
      return;
    }

    setIdentityCandidateLoading(true);
    setPurchaseMemoryLoading(true);
    void (async () => {
      try {
        const db = await getReceiptsDatabase();
        const g4Result = await findPersonalIdentityPromptCandidateForSavedReceipt(
          receiptId,
          db
        );
        if (!identityUpdateAllowed(generation, receiptId)) return;

        if (g4Result.status === 'candidate') {
          setIdentityCandidate(g4Result.candidate);
          setPurchaseMemory(null);
          return;
        }

        setIdentityCandidate(null);

        if (
          !shouldLoadPostSavePurchaseMemory({
            hasIdentityFeedback: false,
            g4CandidateStatus: g4Result.status,
          })
        ) {
          setPurchaseMemory(null);
          return;
        }

        const memoryResult = await loadPostSavePurchaseMemoryWithDb(
          receiptId,
          db
        );
        if (!identityUpdateAllowed(generation, receiptId)) return;

        if (memoryResult.status === 'identity_candidate') {
          setIdentityCandidate(memoryResult.candidate);
          setPurchaseMemory(null);
          return;
        }

        if (memoryResult.status === 'memory') {
          setPurchaseMemory(memoryResult.memory);
          return;
        }

        setPurchaseMemory(null);
      } catch (error) {
        console.error('[PostSaveSummary] product memory load failed', error);
        if (identityUpdateAllowed(generation, receiptId)) {
          setIdentityCandidate(null);
          setPurchaseMemory(null);
        }
      } finally {
        if (identityUpdateAllowed(generation, receiptId)) {
          setIdentityCandidateLoading(false);
          setPurchaseMemoryLoading(false);
        }
      }
    })();
  }, [identityFeedback, routeContext?.receiptId]);

  const reloadIdentityCandidate = async (
    generation: number,
    receiptId: string
  ) => {
    if (!identityUpdateAllowed(generation, receiptId)) return;
    setIdentityCandidateLoading(true);
    try {
      const db = await getReceiptsDatabase();
      const result = await findPersonalIdentityPromptCandidateForSavedReceipt(
        receiptId,
        db
      );
      if (!identityUpdateAllowed(generation, receiptId)) return;
      if (result.status === 'candidate') {
        setIdentityCandidate(result.candidate);
      } else {
        setIdentityCandidate(null);
      }
    } catch (error) {
      console.error('[PostSaveSummary] identity candidate refresh failed', error);
      if (identityUpdateAllowed(generation, receiptId)) {
        setIdentityCandidate(null);
      }
    } finally {
      if (identityUpdateAllowed(generation, receiptId)) {
        setIdentityCandidateLoading(false);
      }
    }
  };

  const handleIdentityChoice = async (
    choice: PersonalIdentityConfirmationChoice
  ) => {
    if (!identityCandidate || identityChoiceProcessing || !routeContext?.receiptId) {
      return;
    }
    const generation = identityGenerationRef.current;
    const receiptId = routeContext.receiptId;
    const candidate = identityCandidate;
    setIdentityConfirmationError(false);
    setIdentityChoiceProcessing(choice);
    try {
      const db = await getReceiptsDatabase();
      const result = await confirmPersonalIdentityCandidateWithDb(
        db,
        candidate,
        choice,
        undefined,
        { locale }
      );
      if (!identityUpdateAllowed(generation, receiptId)) return;
      if (result.status === 'saved') {
        setIdentityCandidate(null);
        setPurchaseMemory(null);
        if (result.feedback) {
          setIdentityFeedback(result.feedback);
        }
        return;
      }
      if (result.status === 'stale_candidate') {
        setIdentityCandidate(null);
        await reloadIdentityCandidate(generation, receiptId);
        return;
      }
      if (
        result.status === 'decision_conflict' ||
        result.status === 'current_endpoint_context_incomplete'
      ) {
        setIdentityCandidate(null);
        await reloadIdentityCandidate(generation, receiptId);
        return;
      }
      if (result.status === 'write_failed') {
        setIdentityConfirmationError(true);
        return;
      }
      setIdentityCandidate(null);
    } catch (error) {
      console.error('[PostSaveSummary] identity confirmation failed', error);
      if (identityUpdateAllowed(generation, receiptId)) {
        setIdentityConfirmationError(true);
      }
    } finally {
      if (identityUpdateAllowed(generation, receiptId)) {
        setIdentityChoiceProcessing(null);
      }
    }
  };

  const milestoneViewModel = buildPostSaveMilestoneViewModel(
    supported,
    evaluation?.status ?? null
  );
  const primaryDestination = getPostSavePrimaryDestination(
    routeContext?.nextDraftId ?? null
  );
  const finish = () => router.replace(primaryDestination as Href);

  const visibleCategories =
    summary?.categoryStructure.categories.filter(
      (entry) => entry.itemCount > 0 || entry.spend > 0
    ) ?? [];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: 40 + Math.max(insets.bottom, 0) }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.successIcon}>
          <Text style={styles.successIconText}>✓</Text>
        </View>
        <Text style={styles.savedTitle}>{t('postSaveSummary.saved')}</Text>
        <Text style={styles.savedSubtitle}>
          {t('postSaveSummary.savedSubtitle')}
        </Text>

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color="#555" />
          </View>
        ) : summary ? (
          <>
            <Text style={styles.sectionTitle}>
              {t('postSaveSummary.current.title')}
            </Text>
            <View style={styles.currentCard}>
              <View style={styles.currentHeader}>
                <View style={styles.currentHeaderText}>
                  <Text style={styles.merchant}>
                    {summary.merchant || t('common.unknownMerchant')}
                  </Text>
                  <Text style={styles.date}>
                    {summary.transactionAt != null
                      ? formatDate(summary.transactionAt)
                      : t('history.detail.dateUnknown')}
                  </Text>
                </View>
                <Text style={styles.total}>
                  {formatAmount(summary.total, summary.currency)}
                </Text>
              </View>
              <View style={styles.details}>
                <Text style={styles.detailText}>
                  {t('postSaveSummary.current.itemCountValue', {
                    count: summary.itemCount,
                  })}
                </Text>
                {summary.highestItem && (
                  <Text style={styles.detailText}>
                    {t('postSaveSummary.current.highestItemValue', {
                      name: summary.highestItem.displayName,
                      amount: formatAmount(
                        summary.highestItem.lineTotal,
                        summary.currency
                      ),
                    })}
                  </Text>
                )}
              </View>
              {visibleCategories.length > 0 && (
                <View style={styles.chips}>
                  {visibleCategories.map((entry) => (
                    <View key={entry.category} style={styles.chip}>
                      <Text style={styles.chipText}>
                        {getCategoryLabel(entry.category as ProductCategory)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {!supported && (
              <Text style={styles.unsupportedNote}>
                {t('postSaveSummary.unsupported')}
              </Text>
            )}

            {identityFeedback ? (
              <PersonalIdentityFeedbackCard feedback={identityFeedback} />
            ) : identityCandidate ? (
              <PersonalIdentityPromptCard
                candidate={identityCandidate}
                processingChoice={identityChoiceProcessing}
                onChoice={handleIdentityChoice}
              />
            ) : purchaseMemory ? (
              <PostSavePurchaseMemoryCard memory={purchaseMemory} />
            ) : identityCandidateLoading || purchaseMemoryLoading ? (
              <View style={styles.identityLoading}>
                <ActivityIndicator color="#777" />
              </View>
            ) : null}

            {identityConfirmationError ? (
              <Text style={styles.identityError}>
                {t('postSaveSummary.identityPrompt.saveFailed')}
              </Text>
            ) : null}

            {supported && evaluation?.unlockedResult && (
              <MilestoneUnlockCard result={evaluation.unlockedResult} />
            )}
            <MilestoneProgress viewModel={milestoneViewModel} />
          </>
        ) : (
          <View style={styles.fallbackCard}>
            <Text style={styles.fallbackText}>
              {t('postSaveSummary.fallback')}
            </Text>
          </View>
        )}

        <View style={styles.actions}>
          <Pressable
            onPress={finish}
            accessibilityRole="button"
            accessibilityLabel={
              routeContext?.nextDraftId
                ? t('postSaveSummary.continueReview')
                : t('postSaveSummary.done')
            }
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {routeContext?.nextDraftId
                ? t('postSaveSummary.continueReview')
                : t('postSaveSummary.done')}
            </Text>
          </Pressable>

          {routeContext?.receiptId && summary && (
            <Pressable
              onPress={() =>
                router.push(
                  `/history/${encodeURIComponent(routeContext.receiptId)}` as Href
                )
              }
              accessibilityRole="button"
              accessibilityLabel={t('postSaveSummary.viewReceipt')}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {t('postSaveSummary.viewReceipt')}
              </Text>
            </Pressable>
          )}

          {milestoneViewModel.profileEstablished && (
            <Pressable
              onPress={() => router.push('/analysis')}
              accessibilityRole="button"
              accessibilityLabel={t('postSaveSummary.viewAnalysis')}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {t('postSaveSummary.viewAnalysis')}
              </Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 30,
    paddingBottom: 45,
  },
  successIcon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: '#222',
  },
  successIconText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '800',
  },
  savedTitle: {
    marginTop: 16,
    color: '#111',
    fontSize: 27,
    fontWeight: '800',
  },
  savedSubtitle: {
    marginTop: 6,
    color: '#666',
    fontSize: 14,
  },
  loading: {
    paddingVertical: 50,
    alignItems: 'center',
  },
  sectionTitle: {
    marginTop: 28,
    marginBottom: 10,
    color: '#111',
    fontSize: 17,
    fontWeight: '800',
  },
  currentCard: {
    padding: 16,
    borderRadius: 15,
    backgroundColor: '#f4f4f4',
  },
  currentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  currentHeaderText: {
    flex: 1,
  },
  merchant: {
    color: '#111',
    fontSize: 17,
    fontWeight: '800',
  },
  date: {
    marginTop: 4,
    color: '#777',
    fontSize: 12,
  },
  total: {
    color: '#111',
    fontSize: 19,
    fontWeight: '800',
  },
  details: {
    marginTop: 13,
    gap: 5,
  },
  detailText: {
    color: '#555',
    fontSize: 13,
    lineHeight: 19,
  },
  chips: {
    marginTop: 13,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  chipText: {
    color: '#444',
    fontSize: 12,
    fontWeight: '600',
  },
  unsupportedNote: {
    marginTop: 12,
    color: '#777',
    fontSize: 12,
    lineHeight: 18,
  },
  identityLoading: {
    marginTop: 20,
    alignItems: 'center',
    paddingVertical: 12,
  },
  identityError: {
    marginTop: 10,
    color: '#b33',
    fontSize: 12,
    lineHeight: 18,
  },
  fallbackCard: {
    marginTop: 28,
    padding: 16,
    borderRadius: 14,
    backgroundColor: '#f4f4f4',
  },
  fallbackText: {
    color: '#555',
    fontSize: 14,
  },
  actions: {
    marginTop: 26,
    gap: 10,
  },
  primaryButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#222',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#bbb',
  },
  secondaryButtonText: {
    color: '#333',
    fontSize: 15,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.58,
  },
});
