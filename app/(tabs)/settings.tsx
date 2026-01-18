// app/(tabs)/settings.tsx

import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
// Lazy import Constants to avoid initialization crashes
let Constants: typeof import('expo-constants') | null = null;

import { PRIVACY_POLICY_URL } from '@/constants/privacy';
import { t } from '@/lib/i18n';

async function getConstants() {
  if (!Constants) {
    try {
      Constants = await import('expo-constants');
    } catch (e) {
      console.warn('[Settings] Failed to import Constants:', e);
      return null;
    }
  }
  return Constants;
}

export default function SettingsScreen() {
  const router = useRouter();
  
  // Delay Constants access to avoid initialization crashes
  const appInfo = useMemo(() => {
    try {
      // Try synchronous access first (may work if already loaded)
      if (typeof require !== 'undefined') {
        try {
          const ConstantsSync = require('expo-constants');
          return {
            version: ConstantsSync?.expoConfig?.version || '1.0.0',
            name: ConstantsSync?.expoConfig?.name || 'Receipt Scanner',
          };
        } catch {
          // Fallback to async if require fails
        }
      }
    } catch (e) {
      console.warn('[Settings] Failed to access Constants synchronously:', e);
    }
    
    // Fallback values
    return {
      version: '1.0.0',
      name: 'Receipt Scanner',
    };
  }, []);
  
  const appVersion = appInfo.version;
  const appName = appInfo.name;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{t('settings.title')}</Text>

      {/* Send Feedback */}
      <Pressable
        style={styles.section}
        onPress={() => router.push('/(tabs)/feedback')}
      >
        <View style={styles.sectionContent}>
          <Text style={styles.sectionTitle}>{t('settings.feedback.title')}</Text>
          <Text style={styles.sectionSubtitle}>{t('settings.feedback.subtitle')}</Text>
        </View>
        <Text style={styles.arrow}>→</Text>
      </Pressable>

      {/* Advanced Insights Pro */}
      <Pressable
        style={styles.section}
        onPress={() => router.push('/(tabs)/pro-insight')}
      >
        <View style={styles.sectionContent}>
          <Text style={styles.sectionTitle}>{t('settings.pro.title')}</Text>
          <Text style={styles.sectionSubtitle}>{t('settings.pro.subtitle')}</Text>
        </View>
        <Text style={styles.arrow}>→</Text>
      </Pressable>

      {/* Privacy Policy */}
      <Pressable
        style={styles.section}
        onPress={async () => {
          try {
            const canOpen = await Linking.canOpenURL(PRIVACY_POLICY_URL);
            if (canOpen) {
              await Linking.openURL(PRIVACY_POLICY_URL);
            } else {
              Alert.alert(
                t('settings.privacy.title'),
                t('settings.privacy.alert'),
                [{ text: t('settings.privacy.ok') || 'OK' }]
              );
            }
          } catch (error) {
            // Fallback to alert if URL opening fails
            Alert.alert(
              t('settings.privacy.title'),
              t('settings.privacy.alert'),
              [{ text: t('settings.privacy.ok') || 'OK' }]
            );
          }
        }}
      >
        <View style={styles.sectionContent}>
          <Text style={styles.sectionTitle}>{t('settings.privacy.title')}</Text>
          <Text style={styles.sectionSubtitle}>{t('settings.privacy.subtitle')}</Text>
        </View>
        <Text style={styles.arrow}>→</Text>
      </Pressable>

      {/* About */}
      <View style={styles.aboutSection}>
        <Text style={styles.aboutTitle}>{t('settings.about.title')}</Text>
        <Text style={styles.aboutText}>
          {appName}
        </Text>
        <Text style={styles.aboutText}>
          {t('settings.about.version')} {appVersion}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: 80,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 32,
  },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  sectionContent: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: '#666',
    lineHeight: 18,
  },
  arrow: {
    fontSize: 20,
    color: '#999',
    marginLeft: 12,
  },
  aboutSection: {
    marginTop: 32,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  aboutTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
    marginBottom: 12,
  },
  aboutText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
});
