// app/(tabs)/settings.tsx

import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
// Lazy import Constants to avoid initialization crashes
let Constants: typeof import('expo-constants') | null = null;

import { PRIVACY_POLICY_URL } from '@/constants/privacy';
import { t } from '@/lib/i18n';
import { listReceipts, updateReceipt } from '@/lib/db';
import { applyCategoriesWithLearning } from '@/lib/receiptEnricher';
import {
  getAllProductDictionaryKeys,
  getProductDictionaryCount,
  getTopProductDictionary,
  upsertProductDictionary,
} from '@/lib/productDictionary';
import { mapLegacyCategoryToV1, buildAnalysisTags } from '@/lib/categoryTaxonomyV1';

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
            version: ConstantsSync?.expoConfig?.version || '1.0.1',
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
      version: '1.0.1',
      name: 'Receipt Scanner',
    };
  }, []);
  
  const appVersion = appInfo.version;
  const appName = appInfo.name;

  const runReclassifyExistingReceipts = useMemo(() => {
    return async () => {
      if (!__DEV__) return;
      try {
        const receipts = await listReceipts(500);
        let touched = 0;
        let skippedNoItems = 0;
        let skippedAlreadyCategorized = 0;
        let skippedUserEdited = 0;
        let failed = 0;

        for (const r of receipts) {
          if (r.user_edited === 1 && r.user_items_json) {
            skippedUserEdited++;
            continue;
          }
          let analysis: any;
          try {
            analysis = JSON.parse(r.analysis_json || '{}');
          } catch {
            continue;
          }
          const items: any[] = Array.isArray(analysis?.items) ? analysis.items : [];
          if (items.length === 0) {
            skippedNoItems++;
            continue;
          }
          const missingBefore = items.filter((it) => !it?.category || String(it.category).trim() === '').length;
          if (missingBefore === 0) {
            skippedAlreadyCategorized++;
            continue;
          }

          try {
            const enriched = await applyCategoriesWithLearning(analysis);
            const afterItems: any[] = Array.isArray(enriched?.items) ? enriched.items : [];
            const missingAfter = afterItems.filter((it) => !it?.category || String(it.category).trim() === '').length;
            await updateReceipt({ id: r.id, analysis: enriched });
            touched++;
            console.log('[DEV][Reclassify] updated', r.id.slice(0, 8), { items: items.length, missingBefore, missingAfter });
          } catch (e: any) {
            failed++;
            console.warn('[DEV][Reclassify] failed', r.id.slice(0, 8), e?.message || e);
          }
        }

        Alert.alert(
          'Reclassify done',
          `updated=${touched}\nuserEditedSkipped=${skippedUserEdited}\nnoItemsSkipped=${skippedNoItems}\nalreadyOkSkipped=${skippedAlreadyCategorized}\nfailed=${failed}`
        );
      } catch (e: any) {
        console.error('[DEV][Reclassify] fatal', e);
        Alert.alert('Reclassify failed', e?.message || String(e));
      }
    };
  }, []);

  const runProductDictionaryStats = useMemo(() => {
    return async () => {
      if (!__DEV__) return;
      try {
        const [dictCount, topDict] = await Promise.all([
          getProductDictionaryCount(),
          getTopProductDictionary(20),
        ]);

        // Also compute "still fallback/uncategorized" candidates from recent receipts
        const receipts = await listReceipts(500);
        const freq = new Map<string, number>();
        for (const r of receipts) {
          let items: any[] = [];
          try {
            if (r.user_edited === 1 && r.user_items_json) {
              items = JSON.parse(r.user_items_json || '[]');
            } else {
              const analysis = JSON.parse(r.analysis_json || '{}');
              items = Array.isArray(analysis?.items) ? analysis.items : [];
            }
          } catch {
            continue;
          }
          for (const it of items) {
            const nn = String((it as any)?.normalized_name || '').trim().toLowerCase();
            if (!nn) continue;
            const status = (it as any)?.classification_status;
            const main = (it as any)?.category_main;
            const cat = String((it as any)?.category || '').trim();

            const isFallbackish =
              status === 'fallback' ||
              !cat ||
              main === 'uncategorized' ||
              main === undefined;

            if (isFallbackish) {
              freq.set(nn, (freq.get(nn) ?? 0) + 1);
            }
          }
        }

        const topFallback = Array.from(freq.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([name, c]) => `${name} (${c})`);

        const topDictLines = topDict.map((x) => `${x.normalized_name} (${x.seen_count})`);

        Alert.alert(
          'Product dictionary stats',
          [
            `dictionary_count=${dictCount}`,
            '',
            'top_dictionary_normalized_name:',
            ...(topDictLines.length ? topDictLines : ['(empty)']),
            '',
            'top_fallback_or_uncategorized_normalized_name:',
            ...(topFallback.length ? topFallback : ['(none in last 500 receipts)']),
          ].join('\n')
        );
      } catch (e: any) {
        console.error('[DEV][ProductDictionaryStats] failed', e);
        Alert.alert('Product dictionary stats failed', e?.message || String(e));
      }
    };
  }, []);

  const runNormalizedNameTop100 = useMemo(() => {
    return async () => {
      if (!__DEV__) return;
      try {
        const receipts = await listReceipts(1200);
        const freq = new Map<string, number>();
        for (const r of receipts) {
          let items: any[] = [];
          try {
            if (r.user_edited === 1 && r.user_items_json) {
              items = JSON.parse(r.user_items_json || '[]');
            } else {
              const analysis = JSON.parse(r.analysis_json || '{}');
              items = Array.isArray(analysis?.items) ? analysis.items : [];
            }
          } catch {
            continue;
          }
          for (const it of items) {
            const nn = String((it as any)?.normalized_name || '').trim().toLowerCase();
            if (!nn) continue;
            freq.set(nn, (freq.get(nn) ?? 0) + 1);
          }
        }
        const top100 = Array.from(freq.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 100)
          .map(([name, c]) => `${name} (${c})`);

        Alert.alert(
          'normalized_name Top 100',
          top100.length ? top100.join('\n') : '(no normalized_name found in receipts)'
        );
      } catch (e: any) {
        console.error('[DEV][TopNormalizedName] failed', e);
        Alert.alert('Top normalized_name failed', e?.message || String(e));
      }
    };
  }, []);

  const runMissingInDictionaryTop100 = useMemo(() => {
    return async () => {
      if (!__DEV__) return;
      try {
        const [receipts, dictKeys] = await Promise.all([
          listReceipts(1500),
          getAllProductDictionaryKeys(),
        ]);
        const dictSet = new Set(dictKeys);
        const freq = new Map<string, number>();
        for (const r of receipts) {
          let items: any[] = [];
          try {
            if (r.user_edited === 1 && r.user_items_json) {
              items = JSON.parse(r.user_items_json || '[]');
            } else {
              const analysis = JSON.parse(r.analysis_json || '{}');
              items = Array.isArray(analysis?.items) ? analysis.items : [];
            }
          } catch {
            continue;
          }
          for (const it of items) {
            const nn = String((it as any)?.normalized_name || '').trim().toLowerCase();
            if (!nn) continue;
            if (dictSet.has(nn)) continue;
            freq.set(nn, (freq.get(nn) ?? 0) + 1);
          }
        }
        const top = Array.from(freq.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 100)
          .map(([name, c]) => `${name} (${c})`);
        Alert.alert(
          'Missing in product_dictionary (Top 100)',
          top.length ? top.join('\n') : '(none)'
        );
      } catch (e: any) {
        console.error('[DEV][MissingInDictionary] failed', e);
        Alert.alert('Missing in dictionary failed', e?.message || String(e));
      }
    };
  }, []);

  const runBackfillProductDictionaryFromReceipts = useMemo(() => {
    return async () => {
      if (!__DEV__) return;
      try {
        const receipts = await listReceipts(2000);
        let touched = 0;
        let skippedNoName = 0;
        let skippedLowQuality = 0;
        let failed = 0;

        for (const r of receipts) {
          let items: any[] = [];
          try {
            if (r.user_edited === 1 && r.user_items_json) {
              items = JSON.parse(r.user_items_json || '[]');
            } else {
              const analysis = JSON.parse(r.analysis_json || '{}');
              items = Array.isArray(analysis?.items) ? analysis.items : [];
            }
          } catch {
            continue;
          }

          for (const it of items) {
            const nn = String((it as any)?.normalized_name || '').trim().toLowerCase();
            if (!nn) {
              skippedNoName++;
              continue;
            }
            const source = String((it as any)?.classification_source || '');
            const conf = Number((it as any)?.classification_confidence ?? 0);
            const status = String((it as any)?.classification_status || '');

            // Minimal controllable policy: only backfill reliable items
            // - user edited receipts (r.user_edited===1) always trusted
            // - rules/ai with high confidence
            // - dictionary/mapping already trusted
            const trustedByUser = r.user_edited === 1;
            const trustedByClassifier =
              source === 'dictionary' ||
              source === 'mapping' ||
              (source === 'rules' && conf >= 0.9) ||
              (source === 'ai' && conf >= 0.85);
            const isBad = status === 'failed' || status === 'fallback';

            if (!trustedByUser && (!trustedByClassifier || isBad)) {
              skippedLowQuality++;
              continue;
            }

            const catMain = (it as any)?.category_main;
            const catSub = (it as any)?.category_sub;
            const legacyCategory = String((it as any)?.category || '').trim();
            const v1 = catMain ? { main: catMain, sub: catSub ?? null } : mapLegacyCategoryToV1(legacyCategory);
            const tags = Array.isArray((it as any)?.analysis_tags) ? (it as any).analysis_tags : buildAnalysisTags(v1 as any);

            try {
              await upsertProductDictionary({
                normalized_name: nn,
                canonical_name: (it as any)?.canonical_name ?? null,
                brand: (it as any)?.brand ?? null,
                category_main: String((v1 as any).main),
                category_sub: (v1 as any).sub ? String((v1 as any).sub) : null,
                analysis_tags: tags,
                confidence: trustedByUser ? 1.0 : conf,
                minConfidenceToWrite: 0, // already gated above
              });
              touched++;
            } catch {
              failed++;
            }
          }
        }

        Alert.alert(
          'Backfill product_dictionary done',
          `upserted=${touched}\nskippedNoName=${skippedNoName}\nskippedLowQuality=${skippedLowQuality}\nfailed=${failed}`
        );
      } catch (e: any) {
        console.error('[DEV][BackfillProductDictionary] fatal', e);
        Alert.alert('Backfill product_dictionary failed', e?.message || String(e));
      }
    };
  }, []);

  const runHitRateStatsFromReceipts = useMemo(() => {
    return async () => {
      if (!__DEV__) return;
      try {
        const receipts = await listReceipts(1500);
        let total = 0;
        const bySource = new Map<string, number>();
        let unknownSource = 0;

        for (const r of receipts) {
          let items: any[] = [];
          try {
            if (r.user_edited === 1 && r.user_items_json) {
              items = JSON.parse(r.user_items_json || '[]');
            } else {
              const analysis = JSON.parse(r.analysis_json || '{}');
              items = Array.isArray(analysis?.items) ? analysis.items : [];
            }
          } catch {
            continue;
          }
          for (const it of items) {
            const nn = String((it as any)?.normalized_name || '').trim().toLowerCase();
            if (!nn) continue;
            total++;
            const source = (it as any)?.classification_source;
            if (!source) {
              unknownSource++;
              continue;
            }
            const key = String(source);
            bySource.set(key, (bySource.get(key) ?? 0) + 1);
          }
        }

        const get = (k: string) => bySource.get(k) ?? 0;
        const dict = get('dictionary');
        const rules = get('rules');
        const ai = get('ai');
        const mapping = get('mapping');
        const fallback = get('fallback');

        const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');

        Alert.alert(
          'Hit rates (from receipts items)',
          [
            `items_total=${total}`,
            `dictionary=${dict} (${pct(dict)}%)`,
            `mapping=${mapping} (${pct(mapping)}%)`,
            `rules=${rules} (${pct(rules)}%)`,
            `ai=${ai} (${pct(ai)}%)`,
            `fallback=${fallback} (${pct(fallback)}%)`,
            `unknown_source=${unknownSource} (${pct(unknownSource)}%)`,
            '',
            'Note: old receipts may have unknown_source until re-scan/reclassify/backfill.',
          ].join('\n')
        );
      } catch (e: any) {
        console.error('[DEV][HitRates] failed', e);
        Alert.alert('Hit rate stats failed', e?.message || String(e));
      }
    };
  }, []);

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

      {__DEV__ && (
        <View style={[styles.aboutSection, { marginTop: 18 }]}>
          <Text style={styles.aboutTitle}>Dev Tools</Text>
          <Pressable
            style={styles.section}
            onPress={runProductDictionaryStats}
          >
            <View style={styles.sectionContent}>
              <Text style={styles.sectionTitle}>Product dictionary stats</Text>
              <Text style={styles.sectionSubtitle}>Count + top names + fallback candidates</Text>
            </View>
            <Text style={styles.arrow}>→</Text>
          </Pressable>
          <Pressable style={styles.section} onPress={runNormalizedNameTop100}>
            <View style={styles.sectionContent}>
              <Text style={styles.sectionTitle}>Top normalized_name (Top 100)</Text>
              <Text style={styles.sectionSubtitle}>From receipts items frequency</Text>
            </View>
            <Text style={styles.arrow}>→</Text>
          </Pressable>
          <Pressable style={styles.section} onPress={runMissingInDictionaryTop100}>
            <View style={styles.sectionContent}>
              <Text style={styles.sectionTitle}>Missing in product_dictionary (Top 100)</Text>
              <Text style={styles.sectionSubtitle}>High priority fill candidates</Text>
            </View>
            <Text style={styles.arrow}>→</Text>
          </Pressable>
          <Pressable style={styles.section} onPress={runBackfillProductDictionaryFromReceipts}>
            <View style={styles.sectionContent}>
              <Text style={styles.sectionTitle}>Backfill product_dictionary from receipts</Text>
              <Text style={styles.sectionSubtitle}>Bulk upsert reliable items only</Text>
            </View>
            <Text style={styles.arrow}>→</Text>
          </Pressable>
          <Pressable style={styles.section} onPress={runHitRateStatsFromReceipts}>
            <View style={styles.sectionContent}>
              <Text style={styles.sectionTitle}>Hit rates: dictionary / rules / AI</Text>
              <Text style={styles.sectionSubtitle}>Computed from receipts items</Text>
            </View>
            <Text style={styles.arrow}>→</Text>
          </Pressable>
          <Pressable
            style={[styles.section, { marginBottom: 0 }]}
            onPress={runReclassifyExistingReceipts}
          >
            <View style={styles.sectionContent}>
              <Text style={styles.sectionTitle}>Reclassify existing receipts</Text>
              <Text style={styles.sectionSubtitle}>One-off: fill missing item.category into analysis_json</Text>
            </View>
            <Text style={styles.arrow}>→</Text>
          </Pressable>
        </View>
      )}
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
