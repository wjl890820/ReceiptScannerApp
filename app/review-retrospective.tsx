import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';

import { t } from '@/lib/i18n';
import { isDevToolsUnlocked } from '@/lib/devToolsAccess';
import { buildReviewRetrospectiveReport, reportToJson, type ReviewRetrospectiveReport } from '@/lib/reviewRetrospective';

export default function ReviewRetrospectiveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  /** null = checking; false = denied; true = allowed */
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<ReviewRetrospectiveReport | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await isDevToolsUnlocked();
      if (cancelled) return;
      if (!ok) {
        Alert.alert(t('devTools.gateTitle'), t('devTools.gateBody'), [
          { text: t('easterEgg.ok'), onPress: () => router.back() },
        ]);
        setUnlocked(false);
        return;
      }
      setUnlocked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, t]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await buildReviewRetrospectiveReport(3000);
      setReport(r);
    } catch (e: any) {
      Alert.alert(t('reviewRetro.errorTitle'), e?.message ?? String(e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (unlocked !== true) return;
    load();
  }, [unlocked, load]);

  const onShareJson = async () => {
    if (!report) return;
    const text = reportToJson(report);
    try {
      await Share.share({ message: text.length > 90000 ? text.slice(0, 90000) + '\n…(truncated)' : text });
    } catch {
      Alert.alert(t('reviewRetro.shareFailed'));
    }
  };

  const onExportFile = async () => {
    if (!report) return;
    const text = reportToJson(report);
    try {
      const base = FileSystem.cacheDirectory;
      if (!base) {
        Alert.alert(t('reviewRetro.exportFailTitle'), t('reviewRetro.noCacheDir'));
        return;
      }
      const path = `${base}review-retrospective-${Date.now()}.json`;
      await FileSystem.writeAsStringAsync(path, text);
      Alert.alert(t('reviewRetro.exportDoneTitle'), path);
    } catch (e: any) {
      Alert.alert(t('reviewRetro.exportFailTitle'), e?.message ?? String(e));
    }
  };

  if (unlocked === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (unlocked === false) {
    return null;
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={[styles.head, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.headBtn}>{t('reviewRetro.back')}</Text>
        </Pressable>
        <Text style={styles.headTitle}>{t('reviewRetro.title')}</Text>
        <Pressable onPress={load} hitSlop={10} disabled={loading}>
          <Text style={styles.headBtn}>{t('reviewRetro.refresh')}</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={{ marginTop: 10 }}>{t('reviewRetro.loading')}</Text>
        </View>
      ) : !report ? (
        <View style={styles.center}>
          <Text>{t('reviewRetro.empty')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.h1}>{t('reviewRetro.sectionSummary')}</Text>
          <Text style={styles.line}>
            {t('reviewRetro.totalReviewed')}: {report.totals.reviewedReceiptCount}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.totalCorrected')}: {report.totals.correctedReceiptCount}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.totalClean')}: {report.totals.fullyUnchangedReceiptCount}
          </Text>

          <Text style={styles.h1}>{t('reviewRetro.sectionBuckets')}</Text>
          <Text style={styles.lineMuted}>{t('reviewRetro.bucketsNote')}</Text>
          <Text style={styles.line}>
            {t('reviewRetro.bucketName')}: {report.buckets.receiptsWithItemNameDiff}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.bucketCategoryOnly')}: {report.buckets.receiptsWithCategoryOnlyDiff}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.bucketHeaderOnly')}: {report.buckets.receiptsWithHeaderNumericOrDateOnly}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.bucketTaggedOcr')}: {report.buckets.receiptsTaggedOcrOrParse}
          </Text>

          <Text style={styles.h1}>{t('reviewRetro.sectionTags')}</Text>
          {Object.entries(report.errorTagCounts)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => (
              <Text key={k} style={styles.line}>
                {k}: {n}
              </Text>
            ))}
          {Object.values(report.errorTagCounts).every((n) => n === 0) && (
            <Text style={styles.lineMuted}>{t('reviewRetro.noTags')}</Text>
          )}

          <Text style={styles.h1}>{t('reviewRetro.sectionTopNames')}</Text>
          {report.topOriginalNamesEdited.length === 0 ? (
            <Text style={styles.lineMuted}>{t('reviewRetro.none')}</Text>
          ) : (
            report.topOriginalNamesEdited.slice(0, 15).map((x) => (
              <Text key={x.originalDisplayName} style={styles.line} numberOfLines={2}>
                {x.events}× {x.originalDisplayName}
              </Text>
            ))
          )}

          <Text style={styles.h1}>{t('reviewRetro.sectionTopAlias')}</Text>
          {report.topAliasCanonicalFromReceipts.length === 0 ? (
            <Text style={styles.lineMuted}>{t('reviewRetro.none')}</Text>
          ) : (
            report.topAliasCanonicalFromReceipts.slice(0, 15).map((x, i) => (
              <Text key={`${x.aliasNormalized}-${i}`} style={styles.line} numberOfLines={3}>
                {x.occurrences}× {x.aliasNormalized} → {x.canonicalName}{' '}
                {x.matchedManualAliasRow ? `(${t('reviewRetro.inAlias')})` : `(${t('reviewRetro.notInAlias')})`}
              </Text>
            ))
          )}

          <Text style={styles.h1}>{t('reviewRetro.sectionCatTrans')}</Text>
          {report.topCategoryTransitions.length === 0 ? (
            <Text style={styles.lineMuted}>{t('reviewRetro.none')}</Text>
          ) : (
            report.topCategoryTransitions.slice(0, 12).map((x, i) => (
              <Text key={`${x.from}-${x.to}-${i}`} style={styles.line}>
                {x.count}× {x.from} → {x.to}
              </Text>
            ))
          )}

          <Text style={styles.h1}>{t('reviewRetro.sectionCatByItem')}</Text>
          {report.topCategoryFixByFinalItemName.length === 0 ? (
            <Text style={styles.lineMuted}>{t('reviewRetro.none')}</Text>
          ) : (
            report.topCategoryFixByFinalItemName.slice(0, 12).map((x) => (
              <Text key={x.itemName} style={styles.line} numberOfLines={2}>
                {x.count}× {x.itemName}
              </Text>
            ))
          )}

          <Text style={styles.h1}>{t('reviewRetro.sectionLearning')}</Text>
          <Text style={styles.line}>
            {t('reviewRetro.nameEvents')}: {report.learning.nameCorrectionEvents}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.nameMatchedAlias')}: {report.learning.nameCorrectionEventsMatchedManualAlias}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.aliasRatio')}:{' '}
            {report.learning.nameCorrectionEvents > 0
              ? `${Math.round(
                  (100 * report.learning.nameCorrectionEventsMatchedManualAlias) /
                    report.learning.nameCorrectionEvents
                )}%`
              : '—'}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.manualAliasRows')}: {report.learning.manualAliasRowCount}
          </Text>
          <Text style={styles.line}>
            {t('reviewRetro.manualDictRows')}: {report.learning.manualDictionaryEntryCount}
          </Text>

          <Text style={styles.h1}>{t('reviewRetro.sectionLegend')}</Text>
          {report.legend.map((line, i) => (
            <Text key={i} style={styles.lineMuted}>
              · {line}
            </Text>
          ))}

          <View style={{ height: 16 }} />
          <Pressable style={styles.btn} onPress={() => setJsonOpen(true)}>
            <Text style={styles.btnText}>{t('reviewRetro.viewJson')}</Text>
          </Pressable>
          <Pressable style={[styles.btn, { marginTop: 10 }]} onPress={onShareJson}>
            <Text style={styles.btnText}>{t('reviewRetro.shareJson')}</Text>
          </Pressable>
          <Pressable style={[styles.btn, { marginTop: 10, marginBottom: 40 }]} onPress={onExportFile}>
            <Text style={styles.btnText}>{t('reviewRetro.exportFile')}</Text>
          </Pressable>
        </ScrollView>
      )}

      <Modal visible={jsonOpen} animationType="slide" onRequestClose={() => setJsonOpen(false)}>
        <View style={[styles.modalHead, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={() => setJsonOpen(false)}>
            <Text style={styles.headBtn}>{t('reviewRetro.close')}</Text>
          </Pressable>
          <Text style={styles.modalTitle}>JSON</Text>
          <View style={{ width: 48 }} />
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
          <Text selectable style={{ fontSize: 11, fontFamily: 'monospace' }}>
            {report ? reportToJson(report) : ''}
          </Text>
        </ScrollView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  headBtn: { fontSize: 16, fontWeight: '700', color: '#06c' },
  headTitle: { fontSize: 17, fontWeight: '800' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  body: { padding: 16, paddingBottom: 32 },
  h1: { fontSize: 17, fontWeight: '900', marginTop: 18, marginBottom: 8 },
  line: { fontSize: 14, marginBottom: 6, color: '#111' },
  lineMuted: { fontSize: 13, marginBottom: 6, color: '#666', lineHeight: 20 },
  btn: {
    backgroundColor: '#111',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  modalTitle: { fontSize: 16, fontWeight: '800' },
});
