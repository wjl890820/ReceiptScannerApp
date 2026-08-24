// app/(tabs)/feedback.tsx

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '@/lib/i18n';
import { submitFeedback } from '@/lib/feedbackService';
import { getSupportEmail } from '@/lib/env';
import { navigateBackOrSettings } from '@/lib/navigationBack';
import { UI_COLORS, UI_LAYOUT, UI_RADIUS, UI_TYPOGRAPHY } from '@/lib/uiTokens';

export default function FeedbackScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [feedback, setFeedback] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const supportEmail = getSupportEmail();

  const openSupportEmail = async (bodyFromState?: string) => {
    if (!supportEmail) {
      Alert.alert(t('feedback.error.title'), t('feedback.error.notConfigured'));
      return;
    }
    const subject = t('feedback.emailSubject');
    const body = bodyFromState && bodyFromState.trim().length > 0 ? bodyFromState : feedback;
    const url = `mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body || '')}`;
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        Alert.alert(t('feedback.error.title'), t('feedback.error.generic'));
      }
    } catch {
      Alert.alert(t('feedback.error.title'), t('feedback.error.generic'));
    }
  };

  const handleSubmit = async () => {
    if (!feedback.trim()) {
      Alert.alert(t('feedback.error.title'), t('feedback.error.required'));
      return;
    }

    if (submitting) {
      return; // Prevent duplicate submissions
    }

    try {
      setSubmitting(true);

      await submitFeedback({
        message: feedback.trim(),
        email: email.trim() || undefined,
      });

      // Success: show alert and clear form
      Alert.alert(
        t('feedback.success.title') || t('feedback.success.fallbackTitle'),
        t('feedback.success.message'),
        [{ text: t('easterEgg.ok'), onPress: () => {} }]
      );
      
      setFeedback('');
      setEmail('');
    } catch (error: any) {
      console.error('[Feedback] Submission error:', error);
      
      // D) UI 行为：失败显示 Alert：标题"提交失败"，内容为简短可读原因
      let errorMessage = t('feedback.error.generic');
      const errorText = error?.message || '';
      
      // 根据错误类型显示不同的错误消息
      if (errorText.includes('网络') || errorText.includes('network') || errorText.includes('无法读取')) {
        errorMessage = t('feedback.error.network');
      } else if (errorText.includes('服务器') || errorText.includes('server') || errorText.includes('HTTP 5')) {
        errorMessage = t('feedback.error.server');
      } else if (errorText.includes('未配置') || errorText.includes('Supabase')) {
        errorMessage = t('feedback.error.notConfigured');
      } else if (errorText.includes('格式错误') || errorText.includes('空响应') || errorText.includes('未确认成功')) {
        errorMessage = t('feedback.error.badResponse');
      }
      
      // 显示错误 Alert，不清空输入（用户可以重试）
      if (errorMessage === t('feedback.error.notConfigured') && supportEmail) {
        Alert.alert(t('feedback.error.title'), errorMessage, [
          { text: t('easterEgg.ok'), style: 'cancel' },
          {
            text: t('feedback.emailFallbackAction'),
            onPress: () => {
              openSupportEmail();
            },
          },
        ]);
      } else {
        Alert.alert(t('feedback.error.title'), errorMessage);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        styles.container,
        {
          paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap,
          paddingBottom: 40 + Math.max(insets.bottom, 0),
        },
      ]}
    >
      <Pressable
        style={styles.backButton}
        onPress={() => navigateBackOrSettings(router)}
        accessibilityRole="button"
        accessibilityLabel={t('feedback.back')}
        hitSlop={8}
      >
        <Text style={styles.backButtonText}>← {t('feedback.back')}</Text>
      </Pressable>

      <Text style={styles.title}>{t('feedback.title')}</Text>
      <Text style={styles.subtitle}>{t('feedback.subtitle')}</Text>

      <View style={styles.form}>
        <Text style={styles.label}>{t('feedback.feedbackLabel')} *</Text>
        <TextInput
          style={styles.textInput}
          multiline
          numberOfLines={6}
          placeholder={t('feedback.feedbackPlaceholder')}
          value={feedback}
          onChangeText={setFeedback}
          textAlignVertical="top"
        />

        <Text style={styles.label}>{t('feedback.emailLabel')}</Text>
        <TextInput
          style={styles.textInput}
          keyboardType="email-address"
          autoCapitalize="none"
          placeholder={t('feedback.emailPlaceholder')}
          value={email}
          onChangeText={setEmail}
        />

        <Pressable
          style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={submitting ? t('feedback.submitting') : t('feedback.submit')}
          accessibilityState={{ disabled: submitting, busy: submitting }}
        >
          <Text style={styles.submitButtonText}>
            {submitting ? t('feedback.submitting') : t('feedback.submit')}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: UI_COLORS.background },
  container: {
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingBottom: 0,
  },
  backButton: {
    minHeight: UI_LAYOUT.controlMinHeight,
    justifyContent: 'center',
    marginBottom: 20,
  },
  backButtonText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '600',
  },
  title: {
    fontSize: UI_TYPOGRAPHY.pageTitle,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#555',
    marginBottom: 32,
  },
  form: {
    marginTop: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
    marginTop: 16,
  },
  textInput: {
    backgroundColor: '#f8f8f8',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    minHeight: 120,
  },
  submitButton: {
    backgroundColor: UI_COLORS.textPrimary,
    borderRadius: UI_RADIUS.card,
    minHeight: UI_LAYOUT.controlMinHeight,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});
