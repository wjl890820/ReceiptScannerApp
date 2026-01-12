// app/(tabs)/feedback.tsx

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';

import { t, getCurrentLocale } from '@/lib/i18n';

export default function FeedbackScreen() {
  const router = useRouter();
  const [feedback, setFeedback] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = async () => {
    if (!feedback.trim()) {
      Alert.alert(t('feedback.error.title'), t('feedback.error.required'));
      return;
    }

    try {
      const appVersion = Constants.expoConfig?.version || '1.0.0';
      const currentLanguage = getCurrentLocale();
      const platform = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web';

      const subject = encodeURIComponent(`[ReceiptScannerApp Feedback] v${appVersion}`);
      
      let body = `Feedback / Issue:\n\n${feedback.trim()}\n\n\nContext:\n\nSystem Info:\n- App Version: ${appVersion}\n- Platform: ${platform}\n- Language: ${currentLanguage}`;
      
      if (email.trim()) {
        body += `\n- Contact Email: ${email.trim()}`;
      }

      const encodedBody = encodeURIComponent(body);
      const mailtoUrl = `mailto:your_email@example.com?subject=${subject}&body=${encodedBody}`;

      const canOpen = await Linking.canOpenURL(mailtoUrl);
      if (canOpen) {
        await Linking.openURL(mailtoUrl);
        // 清空表单
        setFeedback('');
        setEmail('');
      } else {
        Alert.alert(t('feedback.error.title'), t('feedback.error.noEmailApp'));
      }
    } catch (error: any) {
      console.error('打开邮件失败:', error);
      Alert.alert(t('feedback.error.title'), t('feedback.error.generic'));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Pressable style={styles.backButton} onPress={() => router.back()}>
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

        <Pressable style={styles.submitButton} onPress={handleSubmit}>
          <Text style={styles.submitButtonText}>{t('feedback.submit')}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 60,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  backButton: {
    marginBottom: 20,
  },
  backButtonText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '600',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
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
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 32,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});
