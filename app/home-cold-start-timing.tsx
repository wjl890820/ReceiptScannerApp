import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import {
  readHomeColdStartTimingSummaries,
  type HomeColdStartTimingSummary,
} from '@/lib/homeColdStartTiming';
import { UI_COLORS, UI_RADIUS } from '@/lib/uiTokens';

export default function HomeColdStartTimingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [summaries, setSummaries] = useState<HomeColdStartTimingSummary[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSummaries(await readHomeColdStartTimingSummaries());
    } catch (error) {
      Alert.alert(
        'Timing reports unavailable',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const exportText = useMemo(
    () => JSON.stringify({ reports: summaries }, null, 2),
    [summaries]
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 32,
        paddingHorizontal: 16,
      }}
    >
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={styles.back}>Back</Text>
        </Pressable>
        <Text style={styles.title}>Home Cold-Start Timing</Text>
      </View>
      <Text style={styles.subtitle}>
        Local-only diagnostic · durations and counts only · last 10 launches
      </Text>

      <View style={styles.actions}>
        <Pressable
          style={styles.primaryButton}
          accessibilityRole="button"
          onPress={() =>
            void Share.share({
              title: 'Home cold-start timing',
              message: exportText,
            })
          }
          disabled={summaries.length === 0}
        >
          <Text style={styles.primaryButtonText}>Share JSON</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryButton}
          accessibilityRole="button"
          onPress={() => void refresh()}
        >
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={UI_COLORS.accent} />
      ) : summaries.length === 0 ? (
        <Text style={styles.empty}>No timing reports stored yet.</Text>
      ) : (
        [...summaries].reverse().map((summary) => (
          <View key={summary.correlationId} style={styles.report}>
            <Text style={styles.reportTitle}>{summary.correlationId}</Text>
            <Text style={styles.reportMeta}>
              {new Date(summary.completedAtEpochMs).toLocaleString()} ·{' '}
              {summary.outcome}
            </Text>
            <Text selectable style={styles.json}>
              {JSON.stringify(summary, null, 2)}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: UI_COLORS.background },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  back: { color: UI_COLORS.accent, fontSize: 16, fontWeight: '600' },
  title: { color: UI_COLORS.textPrimary, fontSize: 24, fontWeight: '800', flex: 1 },
  subtitle: {
    color: UI_COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
    marginBottom: 16,
  },
  actions: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  primaryButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.accent,
  },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '700' },
  secondaryButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surface,
  },
  secondaryButtonText: { color: UI_COLORS.textPrimary, fontWeight: '600' },
  empty: { color: UI_COLORS.textSecondary, fontSize: 15 },
  report: {
    backgroundColor: UI_COLORS.surface,
    borderRadius: UI_RADIUS.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    padding: 14,
    marginBottom: 12,
  },
  reportTitle: { color: UI_COLORS.textPrimary, fontSize: 14, fontWeight: '700' },
  reportMeta: {
    color: UI_COLORS.textSecondary,
    fontSize: 12,
    marginTop: 3,
    marginBottom: 10,
  },
  json: {
    color: UI_COLORS.textPrimary,
    fontSize: 11,
    lineHeight: 16,
    fontVariant: ['tabular-nums'],
  },
});
