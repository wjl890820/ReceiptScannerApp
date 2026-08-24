// app/(tabs)/settings.tsx

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, type Href } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PRIVACY_POLICY_URL } from '@/constants/privacy';
import { getAccountProtectionStatus } from '@/lib/accountProtectionStatus';
import { protectCurrentAccountWithApple } from '@/lib/appleAccountProtect';
import { restoreExistingAppleAccount } from '@/lib/appleAccountRestore';
import { mapLegacyCategoryToV1, buildAnalysisTags } from '@/lib/categoryTaxonomyV1';
import { listReceipts } from '@/lib/db';
import { DEV_TOOLS_ENABLED_KEY } from '@/lib/devToolsAccess';
import {
  isAnalysisDDiagnosticsEnabled,
  isAppleLinkEnabled,
} from '@/lib/env';
import { shouldShowAnalysisDDiagnosticsEntry } from '@/lib/analysisDDiagnosticsAccess';
import {
  getCurrentLocalePreference,
  setLocalePreference,
  t,
  type LocalePreference,
} from '@/lib/i18n';
import { getMissingInProductDictionaryTop100 } from '@/lib/missingDictionaryCandidates';
import { getCanonicalNamePriceStats } from '@/lib/priceStats';
import {
  getProductDictionaryCount,
  getTopProductDictionary,
  upsertProductDictionary,
} from '@/lib/productDictionary';
import { reclassifyReceiptsMissingCategories } from '@/lib/reclassifyReceipts';
import {
  UI_COLORS,
  UI_LAYOUT,
  UI_RADIUS,
  UI_TYPOGRAPHY,
} from '@/lib/uiTokens';
import {
  getDefaultReceiptSource,
  setDefaultReceiptSource,
  type ReceiptSource,
} from '@/lib/receiptSourceSettings';
import {
  canUnlockDevToolsViaSecretTap,
  formatAboutVersionLine,
  localePreferenceLabelKey,
  resolveInstalledAppMetadata,
  shouldShowSettingsDevTools,
  shouldShowSettingsProEntry,
} from '@/lib/settingsPresentation';

async function loadInstalledAppMetadataFromNative(): Promise<{
  name: string;
  version: string;
  build: string;
}> {
  let nativeAppVersion: string | null = null;
  let nativeBuildVersion: string | null = null;
  let expoConfig: any = null;
  let manifest2: any = null;

  try {
    const Application = await import('expo-application');
    nativeAppVersion = Application.nativeApplicationVersion ?? null;
    nativeBuildVersion = Application.nativeBuildVersion ?? null;
  } catch (e) {
    console.warn('[Settings] Failed to import expo-application:', e);
  }

  try {
    const mod = await import('expo-constants');
    const constants = (mod as any).default ?? mod;
    expoConfig = constants?.expoConfig ?? null;
    manifest2 = constants?.manifest2 ?? null;
    // Prefer Application.*; Constants fields are deprecated fallbacks only.
    if (!nativeAppVersion) {
      nativeAppVersion = constants?.nativeAppVersion ?? null;
    }
    if (!nativeBuildVersion) {
      nativeBuildVersion = constants?.nativeBuildVersion ?? null;
    }
  } catch (e) {
    console.warn('[Settings] Failed to import expo-constants:', e);
  }

  return resolveInstalledAppMetadata({
    nativeAppVersion,
    nativeBuildVersion,
    expoConfig,
    manifest2,
  });
}

function SettingsRow({
  title,
  subtitle,
  value,
  icon,
  onPress,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {icon ? (
        <View style={styles.rowIcon} importantForAccessibility="no">
          <MaterialIcons name={icon} size={19} color={UI_COLORS.accent} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [devToolsEnabled, setDevToolsEnabled] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string>('—');
  const [currentBuild, setCurrentBuild] = useState<string>('—');
  const [currentName, setCurrentName] = useState<string>('Receipt Scanner');
  const [defaultReceiptSource, setDefaultReceiptSourceState] =
    useState<ReceiptSource>('self');
  const [localePreference, setLocalePreferenceState] =
    useState<LocalePreference>(getCurrentLocalePreference());
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountUi, setAccountUi] = useState<{
    uiState: string;
    pendingOutboxCount: number;
  } | null>(null);
  const tapCountRef = useRef(0);
  const lastTapAtRef = useRef(0);

  const showDevTools = shouldShowSettingsDevTools(devToolsEnabled, __DEV__);
  const showPro = shouldShowSettingsProEntry({ comingSoon: true });
  const showAppleAccount =
    isAppleLinkEnabled() && Platform.OS === 'ios';
  const showAnalysisDDiagnostics = shouldShowAnalysisDDiagnosticsEntry(
    isAnalysisDDiagnosticsEnabled()
  );
  const aboutVersionLine = formatAboutVersionLine(currentVersion, currentBuild);

  const refreshAccountStatus = useMemo(() => {
    return async () => {
      if (!showAppleAccount) {
        setAccountUi(null);
        return;
      }
      try {
        const s = await getAccountProtectionStatus();
        setAccountUi({
          uiState: s.uiState,
          pendingOutboxCount: s.pendingOutboxCount,
        });
      } catch {
        setAccountUi(null);
      }
    };
  }, [showAppleAccount]);

  useEffect(() => {
    void refreshAccountStatus();
  }, [refreshAccountStatus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const meta = await loadInstalledAppMetadataFromNative();
      if (cancelled) return;
      setCurrentVersion(meta.version);
      setCurrentBuild(meta.build);
      setCurrentName(meta.name);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const v = await getDefaultReceiptSource();
      if (!cancelled) setDefaultReceiptSourceState(v);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(DEV_TOOLS_ENABLED_KEY);
        if (!cancelled) setDevToolsEnabled(v === '1');
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onPressProtectWithApple = useMemo(() => {
    return async () => {
      if (accountBusy) return;
      setAccountBusy(true);
      try {
        const result = await protectCurrentAccountWithApple();
        if (result.status === 'ok' || result.status === 'already_protected') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertProtectOk'));
        } else if (result.status === 'canceled') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertCanceled'));
        } else if (result.status === 'apple_identity_in_use') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertProtectConflict'));
        } else if (result.status === 'uid_changed') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertProtectUidChanged'));
        } else if (result.status !== 'flag_off') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertProtectFailed'));
        }
        await refreshAccountStatus();
      } finally {
        setAccountBusy(false);
      }
    };
  }, [accountBusy, refreshAccountStatus]);

  const onPressRestoreExisting = useMemo(() => {
    return async () => {
      if (accountBusy) return;
      setAccountBusy(true);
      try {
        const result = await restoreExistingAppleAccount();
        if (result.status === 'ok') {
          Alert.alert(
            t('settings.account.title'),
            t('settings.account.alertRestoreOk', {
              count: String(result.restoredCount ?? 0),
            })
          );
        } else if (result.status === 'ok_empty') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertRestoreEmpty'));
        } else if (result.status === 'canceled') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertCanceled'));
        } else if (result.status === 'blocked_local_data_present') {
          Alert.alert(
            t('settings.account.title'),
            t('settings.account.alertRestoreBlockedLocal')
          );
        } else if (result.status === 'blocked_pending_local_changes') {
          Alert.alert(
            t('settings.account.title'),
            t('settings.account.alertRestoreBlockedOutbox')
          );
        } else if (result.status === 'restore_failed') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertRestoreFailed'));
        } else if (result.status === 'sign_in_failed' || result.status === 'apple_unavailable') {
          Alert.alert(t('settings.account.title'), t('settings.account.alertSignInFailed'));
        }
        await refreshAccountStatus();
      } finally {
        setAccountBusy(false);
      }
    };
  }, [accountBusy, refreshAccountStatus]);

  const onPressLanguage = useMemo(() => {
    return () => {
      const options: { id: LocalePreference; label: string }[] = [
        {
          id: 'system',
          label: t('settings.language.options.system'),
        },
        { id: 'zh', label: t('settings.language.options.zh') },
        { id: 'ja', label: t('settings.language.options.ja') },
        { id: 'en', label: t('settings.language.options.en') },
      ];
      Alert.alert(
        t('settings.language.title'),
        t('settings.language.pickMessage'),
        [
          ...options.map((option) => ({
            text: option.label,
            onPress: () => {
              void (async () => {
                try {
                  await setLocalePreference(option.id);
                  setLocalePreferenceState(option.id);
                } catch {
                  // Keep current preference if persistence/runtime apply fails.
                }
              })();
            },
          })),
          { text: t('home.scan.cancel'), style: 'cancel' as const },
        ],
        { cancelable: true }
      );
    };
  }, []);

  const onPressDefaultReceiptSource = useMemo(() => {
    return async () => {
      const options: { id: ReceiptSource; label: string }[] = [
        { id: 'self', label: 'self' },
        { id: 'family', label: 'family' },
        { id: 'friend', label: 'friend' },
        { id: 'found', label: 'found' },
        { id: 'test', label: 'test' },
      ];
      Alert.alert(
        'Default receipt source',
        `current: ${defaultReceiptSource}`,
        [
          ...options.map((o) => ({
            text: o.label,
            onPress: async () => {
              await setDefaultReceiptSource(o.id);
              setDefaultReceiptSourceState(o.id);
            },
          })),
          { text: 'Cancel', style: 'cancel' as const },
        ],
        { cancelable: true }
      );
    };
  }, [defaultReceiptSource]);

  const onPressVersionArea = useMemo(() => {
    return async () => {
      // Production Release: ignore secret taps entirely (no unlock path).
      if (!canUnlockDevToolsViaSecretTap(__DEV__)) {
        return;
      }

      const now = Date.now();
      const withinWindow = now - lastTapAtRef.current <= 2000;
      lastTapAtRef.current = now;
      tapCountRef.current = withinWindow ? tapCountRef.current + 1 : 1;

      if (__DEV__) {
        console.log('[Settings][DevToolsTap]', {
          count: tapCountRef.current,
          withinWindow,
        });
      }

      if (tapCountRef.current >= 7) {
        tapCountRef.current = 0;
        try {
          await AsyncStorage.setItem(DEV_TOOLS_ENABLED_KEY, '1');
        } catch {
          // ignore
        }
        setDevToolsEnabled(true);
        Alert.alert(t('settings.devTools.unlocked'));
      }
    };
  }, []);

  const disableDevTools = useMemo(() => {
    return async () => {
      try {
        await AsyncStorage.setItem(DEV_TOOLS_ENABLED_KEY, '0');
      } catch {
        // ignore
      }
      setDevToolsEnabled(false);
    };
  }, []);

  const runReclassifyExistingReceipts = useMemo(() => {
    return async () => {
      if (!__DEV__) return;
      try {
        const s = await reclassifyReceiptsMissingCategories(500);
        Alert.alert(
          'Reclassify done',
          `updated=${s.touched}\nuserEditedSkipped=${s.skippedUserEdited}\nnoItemsSkipped=${s.skippedNoItems}\nalreadyOkSkipped=${s.skippedAlreadyCategorized}\nfailed=${s.failed}`
        );
      } catch (e: any) {
        console.error('[DEV][Reclassify] fatal', e);
        Alert.alert('Reclassify failed', e?.message || String(e));
      }
    };
  }, []);

  const runProductDictionaryStats = useMemo(() => {
    return async () => {
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
      try {
        const rows = await getMissingInProductDictionaryTop100(1500, 100);
        const top = rows.map((r) => `${r.normalized_name} (${r.count})`);
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
                source_type: 'backfill',
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
        const alias = get('alias');
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
            `alias=${alias} (${pct(alias)}%)`,
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

  const runPriceStatsByCanonicalName = useMemo(() => {
    return async () => {
      try {
        const rows = await getCanonicalNamePriceStats(50);
        const lines = rows.map(
          (r) =>
            `${r.canonical_name} | avg=${r.avg_price.toFixed(1)} min=${r.min_price.toFixed(1)} max=${r.max_price.toFixed(
              1
            )} last=${r.last_price.toFixed(1)} count=${r.count}`
        );
        Alert.alert('Price stats by canonical_name (Top 50)', lines.length ? lines.join('\n') : '(no canonical_name yet)');
      } catch (e: any) {
        console.error('[DEV][PriceStats] failed', e);
        Alert.alert('Price stats failed', e?.message || String(e));
      }
    };
  }, []);


  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        {
          paddingTop: insets.top + UI_LAYOUT.safeAreaTopGap,
          paddingBottom: UI_LAYOUT.tabContentClearance + Math.max(insets.bottom, 0),
        },
      ]}
      style={styles.screen}
    >
      <Text style={styles.title}>{t('settings.title')}</Text>

      {showAppleAccount ? (
        <View>
          <Text style={styles.sectionLabel}>{t('settings.account.title')}</Text>
          <View style={[styles.group, styles.accountGroup]}>
            {accountBusy ? (
              <Text style={styles.accountBody}>{t('settings.account.busy')}</Text>
            ) : null}
            {accountUi?.uiState === 'anonymous' ? (
              <>
                <Text style={styles.accountBody}>{t('settings.account.anonymousBody')}</Text>
                <SettingsRow
                  title={t('settings.account.protectAction')}
                  icon="shield"
                  onPress={onPressProtectWithApple}
                  accessibilityLabel={t('settings.account.protectAction')}
                />
              </>
            ) : null}
            {accountUi?.uiState === 'apple_linked_backup_pending' ? (
              <Text style={styles.accountBody}>
                <Text style={styles.accountBodyTitle}>
                  {t('settings.account.linkedPendingTitle')}
                </Text>
                {'\n'}
                {t('settings.account.linkedPendingBody')}
              </Text>
            ) : null}
            {accountUi?.uiState === 'apple_linked_protected' ? (
              <Text style={styles.accountBody}>
                <Text style={styles.accountBodyTitle}>
                  {t('settings.account.protectedTitle')}
                </Text>
                {'\n'}
                {t('settings.account.protectedBody')}
              </Text>
            ) : null}
            {accountUi?.uiState === 'empty_install' ||
            accountUi?.uiState === 'auth_unavailable' ||
            accountUi == null ? (
              <>
                <Text style={styles.accountBody}>{t('settings.account.emptyBody')}</Text>
                <SettingsRow
                  title={t('settings.account.restoreAction')}
                  icon="cloud-download"
                  onPress={onPressRestoreExisting}
                  accessibilityLabel={t('settings.account.restoreAction')}
                />
              </>
            ) : null}
            {accountUi?.uiState === 'anonymous' ? (
              <>
                <View style={styles.separator} />
                <SettingsRow
                  title={t('settings.account.restoreAction')}
                  icon="cloud-download"
                  onPress={onPressRestoreExisting}
                  accessibilityLabel={t('settings.account.restoreAction')}
                />
              </>
            ) : null}
          </View>
        </View>
      ) : null}

      <Text style={styles.sectionLabel}>{t('settings.sections.preferences')}</Text>
      <View style={styles.group}>
        <SettingsRow
          title={t('settings.language.title')}
          icon="language"
          subtitle={t('settings.language.subtitle')}
          value={t(localePreferenceLabelKey(localePreference))}
          onPress={onPressLanguage}
          accessibilityLabel={t('settings.language.title')}
        />
        {showPro ? (
          <>
            <View style={styles.separator} />
            <SettingsRow
              title={t('settings.pro.title')}
              icon="insights"
              subtitle={t('settings.pro.subtitle')}
              onPress={() => router.push('/(tabs)/settings/pro-insight' as any)}
              accessibilityLabel={t('settings.pro.title')}
            />
          </>
        ) : null}
      </View>

      <Text style={styles.sectionLabel}>{t('settings.sections.support')}</Text>
      <View style={styles.group}>
        <SettingsRow
          title={t('settings.feedback.title')}
          icon="chat-bubble-outline"
          subtitle={t('settings.feedback.subtitle')}
          onPress={() => router.push('/(tabs)/settings/feedback' as any)}
          accessibilityLabel={t('settings.feedback.title')}
        />
        <View style={styles.separator} />
        <SettingsRow
          title={t('settings.privacy.title')}
          icon="lock-outline"
          subtitle={t('settings.privacy.subtitle')}
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
            } catch {
              Alert.alert(
                t('settings.privacy.title'),
                t('settings.privacy.alert'),
                [{ text: t('settings.privacy.ok') || 'OK' }]
              );
            }
          }}
          accessibilityLabel={t('settings.privacy.title')}
        />
        <View style={styles.separator} />
        <SettingsRow
          title={t('settings.about.title')}
          icon="info-outline"
          subtitle={`${currentName} · ${aboutVersionLine}`}
          onPress={onPressVersionArea}
          accessibilityLabel={`${t('settings.about.title')}, ${aboutVersionLine}`}
        />
      </View>

      {showAnalysisDDiagnostics ? (
        <View style={styles.devGroup}>
          <Text style={styles.devSectionLabel}>Internal / Validation</Text>
          <View style={styles.group}>
            <SettingsRow
              title="Analysis D Diagnostics"
              subtitle="Read-only real-data validation report"
              onPress={() =>
                router.push('/analysis-d-diagnostics' as Href)
              }
              accessibilityLabel="Analysis D Diagnostics"
            />
          </View>
        </View>
      ) : null}

      {showDevTools ? (
        <View style={styles.devGroup}>
          <Text style={styles.devSectionLabel}>Developer Tools</Text>
          <View style={styles.group}>
            <SettingsRow
              title="Default receipt source"
              subtitle={defaultReceiptSource}
              onPress={onPressDefaultReceiptSource}
              accessibilityLabel="Default receipt source"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Product dictionary stats"
              subtitle="Count + top names + fallback candidates"
              onPress={runProductDictionaryStats}
              accessibilityLabel="Product dictionary stats"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Top normalized_name (Top 100)"
              subtitle="From receipts items frequency"
              onPress={runNormalizedNameTop100}
              accessibilityLabel="Top normalized_name"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Missing in product_dictionary (Top 100)"
              subtitle="High priority fill candidates"
              onPress={runMissingInDictionaryTop100}
              accessibilityLabel="Missing in product_dictionary"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Uncategorized Items"
              subtitle="列表选择分类 → 写入 product_dictionary"
              onPress={() => router.push('/(tabs)/settings/uncategorized-items' as any)}
              accessibilityLabel="Uncategorized Items"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Backfill product_dictionary from receipts"
              subtitle="Bulk upsert reliable items only"
              onPress={runBackfillProductDictionaryFromReceipts}
              accessibilityLabel="Backfill product_dictionary"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Hit rates: dictionary / rules / AI"
              subtitle="Computed from receipts items"
              onPress={runHitRateStatsFromReceipts}
              accessibilityLabel="Hit rates"
            />
            <View style={styles.separator} />
            <SettingsRow
              title={t('reviewRetro.settingsTitle')}
              subtitle={t('reviewRetro.settingsSubtitle')}
              onPress={() => router.push('/review-retrospective' as Href)}
              accessibilityLabel={t('reviewRetro.settingsTitle')}
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Price stats by canonical_name"
              subtitle="avg/min/max/last/count (Top 50)"
              onPress={runPriceStatsByCanonicalName}
              accessibilityLabel="Price stats by canonical_name"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Hide Dev Tools"
              subtitle="Disable and clear local flag"
              onPress={disableDevTools}
              accessibilityLabel="Hide Dev Tools"
            />
            <View style={styles.separator} />
            <SettingsRow
              title="Reclassify existing receipts"
              subtitle="One-off: fill missing item.category into analysis_json"
              onPress={runReclassifyExistingReceipts}
              accessibilityLabel="Reclassify existing receipts"
            />
          </View>
          <View style={styles.debugMeta}>
            <Text style={styles.debugMetaText}>
              currentVersion: {currentVersion}
            </Text>
            <Text style={styles.debugMetaText}>
              currentBuild: {currentBuild}
            </Text>
            <Text style={styles.debugMetaText}>
              devToolsEnabled: {String(devToolsEnabled)}
            </Text>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  container: {
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingBottom: 0,
  },
  title: {
    fontSize: UI_TYPOGRAPHY.pageTitle,
    fontWeight: '800',
    color: '#15181c',
    marginBottom: 26,
  },
  sectionLabel: {
    fontSize: 17,
    fontWeight: '800',
    color: UI_COLORS.textPrimary,
    marginBottom: 10,
  },
  accountBody: {
    fontSize: 14,
    color: UI_COLORS.textSecondary,
    lineHeight: 21,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  accountBodyTitle: {
    color: UI_COLORS.textPrimary,
    fontWeight: '800',
  },
  accountGroup: {
    borderTopWidth: 3,
    borderTopColor: UI_COLORS.accent,
  },
  group: {
    backgroundColor: UI_COLORS.surface,
    borderRadius: UI_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    overflow: 'hidden',
    marginBottom: 26,
  },
  row: {
    minHeight: 64,
    paddingHorizontal: UI_LAYOUT.pageHorizontalPadding,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
    paddingRight: 10,
  },
  rowIcon: {
    width: 32,
    height: 32,
    marginRight: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_COLORS.accentSoft,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#15181c',
  },
  rowSubtitle: {
    marginTop: 3,
    fontSize: 13,
    color: '#68707a',
    lineHeight: 18,
  },
  rowValue: {
    maxWidth: 160,
    flexShrink: 1,
    marginRight: 6,
    fontSize: 14,
    fontWeight: '600',
    color: UI_COLORS.accent,
    textAlign: 'right',
  },
  chevron: {
    fontSize: 24,
    color: '#9aa2ad',
    lineHeight: 26,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: UI_COLORS.borderSubtle,
    marginLeft: 16,
  },
  pressed: {
    opacity: 0.72,
  },
  devGroup: {
    marginTop: 28,
  },
  devSectionLabel: {
    marginBottom: 10,
    marginLeft: 4,
    fontSize: 13,
    fontWeight: '800',
    color: '#8a929c',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  debugMeta: {
    marginTop: 14,
    paddingHorizontal: 4,
  },
  debugMetaText: {
    fontSize: 12,
    color: '#8a929c',
    lineHeight: 17,
  },
});
