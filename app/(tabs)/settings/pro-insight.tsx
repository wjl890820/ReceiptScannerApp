// app/(tabs)/pro-insight.tsx
import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { t } from '@/lib/i18n';
import { navigateBackOrSettings } from '@/lib/navigationBack';
import { shouldShowSettingsProEntry } from '@/lib/settingsPresentation';

/** Release freeze: Pro purchase is not shipped. */
const PRO_COMING_SOON = true;

export default function ProInsightScreen() {
  const router = useRouter();
  const allowed = shouldShowSettingsProEntry({ comingSoon: PRO_COMING_SOON });

  useEffect(() => {
    if (!allowed) {
      router.replace('/(tabs)/settings');
    }
  }, [allowed, router]);

  if (!allowed) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#1677ff" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => navigateBackOrSettings(router)} style={styles.backButton}>
          <Text style={styles.backButtonText}>{t('pro.back')}</Text>
        </Pressable>
        <Text style={styles.title}>{t('pro.title')}</Text>
      </View>

      <View style={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('pro.sections.free.title')}</Text>
          <View style={styles.featureList}>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>•</Text>
              <Text style={styles.featureText}>{t('pro.sections.free.features.basicStats')}</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>•</Text>
              <Text style={styles.featureText}>{t('pro.sections.free.features.timeRanges')}</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>•</Text>
              <Text style={styles.featureText}>{t('pro.sections.free.features.pieChart')}</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>•</Text>
              <Text style={styles.featureText}>{t('pro.sections.free.features.basicInsights')}</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>•</Text>
              <Text style={styles.featureText}>{t('pro.sections.free.features.receiptEdit')}</Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('pro.sections.unlock.title')}</Text>
          <View style={styles.featureList}>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✨</Text>
              <Text style={styles.featureText}>{t('pro.sections.unlock.features.deepAnalysis')}</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✨</Text>
              <Text style={styles.featureText}>{t('pro.sections.unlock.features.longerRanges')}</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureBullet}>✨</Text>
              <Text style={styles.featureText}>{t('pro.sections.unlock.features.fineAlerts')}</Text>
            </View>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('pro.footer')}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  container: {
    flexGrow: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
  },
  backButton: {
    marginBottom: 12,
  },
  backButtonText: {
    fontSize: 16,
    color: '#1677ff',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111',
  },
  content: {
    padding: 20,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    color: '#222',
  },
  featureList: {
    gap: 10,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  featureBullet: {
    fontSize: 16,
    lineHeight: 22,
  },
  featureText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: '#444',
  },
  footer: {
    marginTop: 8,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#eee',
  },
  footerText: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
  },
});
