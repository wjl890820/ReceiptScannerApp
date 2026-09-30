/**
 * Internal / Validation exact-ID verified occurrence repair.
 * Hidden unless Analysis D validation diagnostics are enabled.
 * Dry Run is read-only. Assignment runs only after explicit confirmation.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isAnalysisDDiagnosticsEnabled } from '@/lib/env';
import {
  executeVerifiedOccurrenceRepairForCurrentOwner,
  previewVerifiedOccurrenceRepairForCurrentOwner,
  type ExecuteVerifiedOccurrenceRepairResult,
  type PreviewVerifiedOccurrenceRepairResult,
} from '@/lib/verifiedOccurrenceRepair';
import {
  isVerifiedOccurrenceRepairAssignEnabled,
  parseVerifiedOccurrenceRepairIdInput,
  verifiedOccurrenceRepairCloudRequestFailureMessage,
  verifiedOccurrenceRepairConfirmMessage,
  verifiedOccurrenceRepairVerificationFailureMessage,
} from '@/lib/verifiedOccurrenceRepairInput';

export default function VerifiedOccurrenceRepairScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const enabled = isAnalysisDDiagnosticsEnabled();
  const [draft, setDraft] = useState('');
  const [previewDraft, setPreviewDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewVerifiedOccurrenceRepairResult | null>(
    null
  );
  const [execution, setExecution] =
    useState<ExecuteVerifiedOccurrenceRepairResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) {
      Alert.alert('Repair unavailable', 'Verified occurrence repair is disabled in this build.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    }
  }, [enabled, router]);

  const executionAllowed = preview?.status === 'PREVIEW' && preview.executionAllowed;
  const assignEnabled =
    enabled &&
    !busy &&
    isVerifiedOccurrenceRepairAssignEnabled({
      draftText: draft,
      previewDraftText: previewDraft,
      executionAllowed,
    });

  const runDryRun = useCallback(async () => {
    setExecution(null);
    setMessage(null);
    const parsed = parseVerifiedOccurrenceRepairIdInput(draft);
    if (!parsed.ok) {
      setPreview(null);
      setPreviewDraft(null);
      setMessage(`Input rejected: ${parsed.reason}`);
      return;
    }
    setBusy(true);
    try {
      const next = await previewVerifiedOccurrenceRepairForCurrentOwner(parsed.receiptIds);
      setPreview(next);
      setPreviewDraft(draft);
    } catch (error) {
      setPreview(null);
      setPreviewDraft(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const confirmAssign = useCallback(() => {
    if (!assignEnabled || preview?.status !== 'PREVIEW') return;
    const count = preview.receiptIds.length;
    Alert.alert(
      'Assign as one verified purchase',
      verifiedOccurrenceRepairConfirmMessage(count),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Assign',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              setMessage(null);
              try {
                const result = await executeVerifiedOccurrenceRepairForCurrentOwner(
                  preview.receiptIds
                );
                setExecution(result);
                if (result.status === 'VERIFICATION_FAILED') {
                  setMessage(verifiedOccurrenceRepairVerificationFailureMessage());
                } else if (
                  result.status === 'ASSIGNED' &&
                  result.cloudSyncRequestStatus === 'request_failed'
                ) {
                  setMessage(verifiedOccurrenceRepairCloudRequestFailureMessage());
                }
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ]
    );
  }, [assignEnabled, preview]);

  const dryRun = preview?.status === 'PREVIEW' ? preview.dryRun : null;
  const simulation = dryRun?.simulation ?? null;

  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 12, paddingBottom: 32 }]}
    >
      <Text style={styles.title}>Verified Occurrence Repair</Text>
      <Text style={styles.note}>
        Paste exact receipt IDs. Dry run does not write. Assignment uses user_verified only.
      </Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="One exact receipt ID per line"
        style={styles.input}
      />
      <Pressable disabled={!enabled || busy} onPress={() => void runDryRun()} style={styles.button}>
        <Text style={styles.buttonText}>Dry Run</Text>
      </Pressable>
      {message ? <Text style={styles.warn}>{message}</Text> : null}
      {preview?.status === 'BLOCKED_OWNER' ? (
        <Text style={styles.warn}>Blocked: {preview.reason}</Text>
      ) : null}
      {dryRun ? (
        <View style={styles.panel}>
          <Text>status: {dryRun.status}</Text>
          <Text>selected: {preview?.status === 'PREVIEW' ? preview.receiptIds.length : 0}</Text>
          <Text>owner receipts: {simulation?.ownerReceiptCount ?? 'n/a'}</Text>
          <Text>
            purchases: {simulation?.effectivePurchaseCountBefore ?? 'n/a'} →{' '}
            {simulation?.effectivePurchaseCountAfter ?? 'n/a'} (
            {simulation?.effectivePurchaseDelta ?? 'n/a'})
          </Text>
          <Text>
            selected purchases: {simulation?.selectedEffectiveOccurrenceCountBefore ?? 'n/a'} →{' '}
            {simulation?.selectedEffectiveOccurrenceCountAfter ?? 'n/a'}
          </Text>
          <Text>
            unexpected absorption:{' '}
            {simulation?.unexpectedUnselectedAbsorption ? 'YES' : 'NO'}
          </Text>
          <Text>
            absorbed IDs: {(simulation?.absorbedUnselectedReceiptIds ?? []).join(', ') || 'none'}
          </Text>
          <Text>execution allowed: {executionAllowed && draft === previewDraft ? 'YES' : 'NO'}</Text>
          {preview?.status === 'PREVIEW' && preview.alreadyAssigned ? (
            <Text>existing occurrence: {preview.existingOccurrenceId ?? 'n/a'}</Text>
          ) : null}
        </View>
      ) : null}
      <Pressable
        disabled={!assignEnabled}
        onPress={confirmAssign}
        style={[styles.danger, !assignEnabled ? styles.disabled : null]}
      >
        <Text style={styles.buttonText}>Assign as one verified purchase</Text>
      </Pressable>
      {execution?.status === 'ASSIGNED' ? (
        <View style={styles.panel}>
          <Text>occurrence ID: {execution.occurrenceId}</Text>
          <Text>changed: {execution.changedReceiptIds.length}</Text>
          <Text>unchanged: {execution.unchangedReceiptIds.length}</Text>
          <Text>local verification = {execution.postVerificationStatus}</Text>
          <Text>cloud sync request: {execution.cloudSyncRequestStatus}</Text>
          {execution.cloudSyncRequestStatus === 'request_failed' ? (
            <Text>{verifiedOccurrenceRepairCloudRequestFailureMessage()}</Text>
          ) : null}
        </View>
      ) : null}
      {execution?.status === 'ALREADY_COMPLETE' ? (
        <View style={styles.panel}>
          <Text>already assigned: {execution.occurrenceId}</Text>
          <Text>local verification = {execution.postVerificationStatus}</Text>
          <Text>cloud sync request: {execution.cloudSyncRequestStatus}</Text>
        </View>
      ) : null}
      {execution?.status === 'VERIFICATION_FAILED' ? (
        <View style={styles.panel}>
          <Text>{verifiedOccurrenceRepairVerificationFailureMessage()}</Text>
          <Text>occurrence ID: {execution.occurrenceId}</Text>
          <Text>local assignment committed: YES</Text>
          <Text>post={execution.postVerificationStatus}</Text>
          <Text>cloud sync request: {execution.cloudSyncRequestStatus}</Text>
          {execution.cloudSyncRequestStatus === 'request_failed' ? (
            <Text>{verifiedOccurrenceRepairCloudRequestFailureMessage()}</Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: '600' },
  note: { color: '#444' },
  input: {
    minHeight: 140,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    textAlignVertical: 'top',
  },
  button: { backgroundColor: '#245', padding: 12, borderRadius: 8 },
  danger: { backgroundColor: '#822', padding: 12, borderRadius: 8 },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600' },
  panel: { gap: 4, padding: 10, backgroundColor: '#f4f4f4', borderRadius: 8 },
  warn: { color: '#822' },
});
