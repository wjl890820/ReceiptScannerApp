import { useRouter, type Href } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { formatDate } from '@/lib/formatDate';
import { t } from '@/lib/i18n';
import type { PersonalIdentityPromptCandidateV1 } from '@/lib/personalProductIdentityCandidateService';
import type {
  PersonalIdentityConfirmationChoice,
  PersonalIdentityConfirmationFeedback,
} from '@/lib/personalProductIdentityConfirmationCoordinator';
import {
  personalIdentityPromptExplanationKey,
  resolvePersonalIdentityFeedbackPresentation,
} from '@/lib/personalProductIdentityConfirmationPresentation';
import { buildProductDetailHref } from '@/lib/productDetailTarget';
import { UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

type ProductSideProps = {
  label: string;
  displayName: string;
  specificationLabel: string | null;
  merchantName: string;
  priorDate?: number | null;
};

function ProductSide({
  label,
  displayName,
  specificationLabel,
  merchantName,
  priorDate,
}: ProductSideProps) {
  return (
    <View style={styles.side}>
      <Text style={styles.sideLabel}>{label}</Text>
      <Text style={styles.productName}>{displayName}</Text>
      {specificationLabel ? (
        <Text style={styles.productMeta}>{specificationLabel}</Text>
      ) : null}
      <Text style={styles.productMeta}>{merchantName}</Text>
      {priorDate != null ? (
        <Text style={styles.productMeta}>
          {t('postSaveSummary.identityPrompt.priorPurchase', {
            date: formatDate(priorDate),
          })}
        </Text>
      ) : null}
    </View>
  );
}

export function PersonalIdentityPromptCard({
  candidate,
  processingChoice,
  onChoice,
}: {
  candidate: PersonalIdentityPromptCandidateV1;
  processingChoice: PersonalIdentityConfirmationChoice | null;
  onChoice: (choice: PersonalIdentityConfirmationChoice) => void;
}) {
  const disabled = processingChoice != null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t('postSaveSummary.identityPrompt.title')}</Text>
      <Text style={styles.explanation}>
        {t(personalIdentityPromptExplanationKey(candidate.value.reason))}
      </Text>
      <Text style={styles.helper}>{t('postSaveSummary.identityPrompt.helper')}</Text>

      <View style={styles.comparison}>
        <ProductSide
          label={t('postSaveSummary.identityPrompt.currentLabel')}
          displayName={candidate.current.displayName}
          specificationLabel={candidate.current.specificationLabel}
          merchantName={candidate.current.merchantName}
        />
        <View style={styles.divider} />
        <ProductSide
          label={t('postSaveSummary.identityPrompt.historicalLabel')}
          displayName={candidate.historical.displayName}
          specificationLabel={candidate.historical.specificationLabel}
          merchantName={candidate.historical.merchantName}
          priorDate={candidate.historical.lastPurchasedAt}
        />
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => onChoice('same_product')}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t('postSaveSummary.identityPrompt.yesAccessibility')}
          accessibilityState={{ disabled }}
          style={({ pressed }) => [
            styles.primaryButton,
            disabled && styles.buttonDisabled,
            pressed && !disabled && styles.pressed,
          ]}
        >
          {processingChoice === 'same_product' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {t('postSaveSummary.identityPrompt.yes')}
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => onChoice('not_same_product')}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t('postSaveSummary.identityPrompt.noAccessibility')}
          accessibilityState={{ disabled }}
          style={({ pressed }) => [
            styles.secondaryButton,
            disabled && styles.buttonDisabled,
            pressed && !disabled && styles.pressed,
          ]}
        >
          {processingChoice === 'not_same_product' ? (
            <ActivityIndicator color={UI_COLORS.textPrimary} />
          ) : (
            <Text style={styles.secondaryButtonText}>
              {t('postSaveSummary.identityPrompt.no')}
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => onChoice('unsure')}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t('postSaveSummary.identityPrompt.unsureAccessibility')}
          accessibilityState={{ disabled }}
          style={({ pressed }) => [
            styles.tertiaryButton,
            disabled && styles.buttonDisabled,
            pressed && !disabled && styles.pressed,
          ]}
        >
          {processingChoice === 'unsure' ? (
            <ActivityIndicator color={UI_COLORS.textSecondary} />
          ) : (
            <Text style={styles.tertiaryButtonText}>
              {t('postSaveSummary.identityPrompt.unsure')}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

export function PersonalIdentityFeedbackCard({
  feedback,
}: {
  feedback: PersonalIdentityConfirmationFeedback;
}) {
  const router = useRouter();
  const presentation = resolvePersonalIdentityFeedbackPresentation(feedback);

  return (
    <View style={styles.card}>
      <Text style={styles.feedbackTitle}>
        {t('postSaveSummary.identityFeedback.savedTitle')}
      </Text>

      {presentation.mode === 'exact_price' ? (
        <>
          <Text style={styles.feedbackBody}>
            {t('postSaveSummary.identityFeedback.priceConnected')}
          </Text>
          {presentation.priceChangeTextKey ? (
            <Text style={styles.feedbackHighlight}>
              {presentation.priceChangeTextParams
                ? t(
                    presentation.priceChangeTextKey,
                    presentation.priceChangeTextParams
                  )
                : t(presentation.priceChangeTextKey)}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.feedbackBody}>
            {t('postSaveSummary.identityFeedback.historyConnected')}
          </Text>
          <Text style={styles.feedbackBody}>
            {t('postSaveSummary.identityFeedback.historyConnectedDetail')}
          </Text>
        </>
      )}

      {feedback.purchaseOccurrenceCount != null &&
      feedback.purchaseOccurrenceCount > 0 ? (
        <Text style={styles.feedbackMeta}>
          {t('postSaveSummary.identityFeedback.purchaseCount', {
            count: feedback.purchaseOccurrenceCount,
          })}
          {feedback.merchantCount != null && feedback.merchantCount > 0
            ? ` · ${t('postSaveSummary.identityFeedback.merchantCount', {
                count: feedback.merchantCount,
              })}`
            : ''}
        </Text>
      ) : null}

      {feedback.target ? (
        <Pressable
          onPress={() =>
            router.push(buildProductDetailHref(feedback.target!) as Href)
          }
          accessibilityRole="button"
          accessibilityLabel={t('postSaveSummary.identityFeedback.viewHistory')}
          style={({ pressed }) => [
            styles.linkButton,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.linkButtonText}>
            {t('postSaveSummary.identityFeedback.viewHistory')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 20,
    padding: 16,
    borderRadius: UI_RADIUS.card,
    backgroundColor: UI_COLORS.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
  },
  title: {
    color: UI_COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  explanation: {
    marginTop: 8,
    color: UI_COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  helper: {
    marginTop: 6,
    color: UI_COLORS.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  comparison: {
    marginTop: 14,
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surface,
    overflow: 'hidden',
  },
  side: {
    padding: 12,
  },
  sideLabel: {
    color: UI_COLORS.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  productName: {
    marginTop: 4,
    color: UI_COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  productMeta: {
    marginTop: 3,
    color: UI_COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: UI_COLORS.border,
  },
  actions: {
    marginTop: 14,
    gap: 8,
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.charcoal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: UI_COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  tertiaryButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  tertiaryButtonText: {
    color: UI_COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  pressed: {
    opacity: 0.75,
  },
  feedbackTitle: {
    color: UI_COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  feedbackBody: {
    marginTop: 8,
    color: UI_COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  feedbackHighlight: {
    marginTop: 8,
    color: UI_COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  feedbackMeta: {
    marginTop: 8,
    color: UI_COLORS.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  linkButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  linkButtonText: {
    color: UI_COLORS.accent,
    fontSize: 14,
    fontWeight: '700',
  },
});
