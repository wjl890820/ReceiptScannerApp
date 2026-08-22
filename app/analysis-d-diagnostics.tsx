/**
 * Validation-only Analysis D diagnostics screen (D1-A).
 * Hidden unless ENABLE_ANALYSIS_D_DIAGNOSTICS is ON.
 * Read-only: generate / refresh / manual JSON share. No domain writes.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import type { AnalysisDReport } from '@/lib/analysisDReport';
import type { AnalysisDDuplicateScanAudit } from '@/lib/analysisDDuplicateAudit';
import {
  ANALYSIS_D_EXPORT_PRIVACY_WARNING,
  buildAnalysisDDiagnosticsViewModel,
  buildAnalysisDSharePayload,
  shareAnalysisDJsonFile,
  writeAnalysisDJsonExportFile,
  type AnalysisDDiagnosticsViewModel,
} from '@/lib/analysisDDiagnosticsAccess';
import { generateAnalysisDDiagnosticsBundle } from '@/lib/analysisDDiagnosticsGenerate';
import { isAnalysisDDiagnosticsEnabled } from '@/lib/env';

export default function AnalysisDDiagnosticsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const enabled = isAnalysisDDiagnosticsEnabled();

  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<AnalysisDReport | null>(null);
  const [storedScanBaseline, setStoredScanBaseline] =
    useState<AnalysisDReport | null>(null);
  const [selectionMeta, setSelectionMeta] = useState<{
    storedReceiptCount: number;
    analyticsPurchaseCandidateCount: number;
    highConfidenceDuplicateExtras: number;
  } | null>(null);
  const [duplicateScanAudit, setDuplicateScanAudit] =
    useState<AnalysisDDuplicateScanAudit | null>(null);
  const [viewModel, setViewModel] =
    useState<AnalysisDDiagnosticsViewModel | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      Alert.alert(
        'Diagnostics unavailable',
        'Analysis D diagnostics are disabled in this build.',
        [{ text: 'OK', onPress: () => router.back() }]
      );
    }
  }, [enabled, router]);

  const generate = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const next = await generateAnalysisDDiagnosticsBundle();
      setReport(next.productionAnalytics);
      setStoredScanBaseline(next.storedScanBaseline);
      setSelectionMeta(next.selection);
      setDuplicateScanAudit(next.duplicateScanAudit);
      setViewModel(
        buildAnalysisDDiagnosticsViewModel(
          next.productionAnalytics,
          next.duplicateScanAudit,
          {
            storedScanBaseline: next.storedScanBaseline,
            selection: {
              storedReceiptCount: next.selection.storedReceiptCount,
              analyticsPurchaseCandidateCount:
                next.selection.analyticsPurchaseCandidateCount,
              highConfidenceDuplicateExtras:
                next.selection.highConfidenceDuplicateExtras,
            },
          }
        )
      );
    } catch (e: unknown) {
      const message =
        e instanceof Error
          ? e.message
          : `Report generation failed: ${String(e)}`;
      setErrorMessage(message);
      setReport(null);
      setStoredScanBaseline(null);
      setSelectionMeta(null);
      setDuplicateScanAudit(null);
      setViewModel(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const onShareSummary = useCallback(async () => {
    if (!viewModel) return;
    try {
      await Share.share({ message: viewModel.summaryText });
    } catch (e: unknown) {
      Alert.alert(
        'Share failed',
        e instanceof Error ? e.message : String(e)
      );
    }
  }, [viewModel]);

  const onExportJson = useCallback(async () => {
    if (!report) return;
    const payload = buildAnalysisDSharePayload(
      report,
      Date.now(),
      duplicateScanAudit,
      {
        storedScanBaseline,
        selection: selectionMeta
          ? {
              storedReceiptCount: selectionMeta.storedReceiptCount,
              analyticsPurchaseCandidateCount:
                selectionMeta.analyticsPurchaseCandidateCount,
              highConfidenceDuplicateExtras:
                selectionMeta.highConfidenceDuplicateExtras,
            }
          : null,
      }
    );
    Alert.alert('Private data', payload.privacyWarning, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Share JSON',
        onPress: async () => {
          try {
            const written = await writeAnalysisDJsonExportFile({
              report,
              duplicateScanAudit,
              storedScanBaseline,
              selection: selectionMeta
                ? {
                    storedReceiptCount: selectionMeta.storedReceiptCount,
                    analyticsPurchaseCandidateCount:
                      selectionMeta.analyticsPurchaseCandidateCount,
                    highConfidenceDuplicateExtras:
                      selectionMeta.highConfidenceDuplicateExtras,
                  }
                : null,
              cacheDirectory: FileSystem.cacheDirectory,
              writeAsStringAsync: FileSystem.writeAsStringAsync,
            });
            await shareAnalysisDJsonFile({
              fileUri: written.fileUri,
              filename: written.filename,
              isAvailableAsync: Sharing.isAvailableAsync,
              shareAsync: Sharing.shareAsync,
            });
          } catch (e: unknown) {
            Alert.alert(
              'Export failed',
              e instanceof Error ? e.message : String(e)
            );
          }
        },
      },
    ]);
  }, [report, duplicateScanAudit, storedScanBaseline, selectionMeta]);

  if (!enabled) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.title}>Analysis D Diagnostics</Text>
        <Text style={styles.body}>Disabled in this build.</Text>
        <Pressable style={styles.button} onPress={() => router.back()}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 40,
        paddingHorizontal: 16,
      }}
    >
      <Text style={styles.title}>Analysis D Diagnostics</Text>
      <Text style={styles.subtitle}>
        Validation-only · read-only · local receipts · no auto-upload
      </Text>

      <View style={styles.actions}>
        <Pressable
          style={[styles.button, loading && styles.buttonDisabled]}
          disabled={loading}
          onPress={() => void generate()}
          accessibilityRole="button"
          accessibilityLabel="Generate report"
        >
          <Text style={styles.buttonText}>
            {report ? 'Refresh report' : 'Generate report'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.buttonSecondary, !report && styles.buttonDisabled]}
          disabled={!report || loading}
          onPress={() => void onExportJson()}
          accessibilityRole="button"
          accessibilityLabel="Share export JSON"
        >
          <Text style={styles.buttonSecondaryText}>Share / Export JSON</Text>
        </Pressable>
        <Pressable
          style={[styles.buttonSecondary, !viewModel && styles.buttonDisabled]}
          disabled={!viewModel || loading}
          onPress={() => void onShareSummary()}
          accessibilityRole="button"
          accessibilityLabel="Share summary"
        >
          <Text style={styles.buttonSecondaryText}>Share summary</Text>
        </Pressable>
        <Pressable
          style={styles.buttonGhost}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.buttonGhostText}>Back</Text>
        </Pressable>
      </View>

      <Text style={styles.warning}>{ANALYSIS_D_EXPORT_PRIVACY_WARNING}</Text>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator />
          <Text style={styles.body}>Generating from local receipts…</Text>
        </View>
      ) : null}

      {errorMessage ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Generation error</Text>
          <Text style={styles.errorBody}>{errorMessage}</Text>
        </View>
      ) : null}

      {viewModel ? (
        <View style={styles.reportBox}>
          <Text style={styles.sectionTitle}>generatedAt</Text>
          <Text style={styles.mono}>{viewModel.generatedAtLabel}</Text>

          <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Summary</Text>
          <Text style={styles.mono}>{viewModel.summaryText}</Text>

          {viewModel.sections.map((section) => (
            <View key={section.title} style={styles.sectionBlock}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.lines.map((line) => (
                <Text key={`${section.title}:${line}`} style={styles.line}>
                  {line}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : !loading && !errorMessage ? (
        <Text style={styles.body}>
          Tap Generate report to observe the current local dataset. No domain
          data will be modified.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f8fa' },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#15181c',
    marginBottom: 6,
  },
  subtitle: { fontSize: 13, color: '#68707a', marginBottom: 16 },
  body: { fontSize: 14, color: '#3c4450', lineHeight: 20 },
  warning: {
    fontSize: 12,
    color: '#8a5a00',
    backgroundColor: '#fff7e6',
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
    overflow: 'hidden',
  },
  actions: { gap: 10, marginBottom: 14 },
  button: {
    backgroundColor: '#1f6feb',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  buttonSecondary: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c9d0d8',
  },
  buttonSecondaryText: { color: '#1f6feb', fontWeight: '700', fontSize: 15 },
  buttonGhost: { paddingVertical: 8, alignItems: 'center' },
  buttonGhostText: { color: '#68707a', fontWeight: '600' },
  loadingBox: { alignItems: 'center', gap: 8, paddingVertical: 20 },
  errorBox: {
    backgroundColor: '#fff1f0',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  errorTitle: { fontWeight: '800', color: '#a8071a', marginBottom: 4 },
  errorBody: { color: '#5c0011', fontSize: 13 },
  reportBox: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e1e4e8',
  },
  sectionBlock: { marginTop: 14 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#68707a',
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  line: { fontSize: 14, color: '#15181c', marginBottom: 3 },
  mono: {
    fontSize: 12,
    color: '#3c4450',
    fontFamily: 'Courier',
    lineHeight: 17,
  },
});
