/**
 * Shared receipt-scan orchestration (camera / album → OCR → Review).
 * Extracted from Home so any screen can launch the same production flow.
 * Accepts image URIs only — no product identity payload.
 */

import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { t } from '@/lib/i18n';
import { logger } from '@/lib/logger';
import { pingOcrEdge, probeSupabaseNetwork } from '@/lib/ocrService';
import { getScanErrorMessage } from '@/lib/scanError';
import {
  runScanPipelineToReview,
  type ScanOneResult,
} from '@/lib/scanPipeline';
import {
  clearScanReviewQueue,
  setScanReviewQueue,
} from '@/lib/scanReviewQueue';
import {
  buildBatchFailureSummary,
  collectFailedScanItems,
  mergeDraftIdsAfterRetry,
  type FailedScanItem,
} from '@/lib/scanRetryHelpers';

export type ReceiptScanLauncher = {
  launchReceiptScan: () => void;
  isScanning: boolean;
  processingProgress: { current: number; total: number } | null;
};

export function useReceiptScanLauncher(): ReceiptScanLauncher {
  const router = useRouter();
  const [isScanning, setIsScanning] = useState(false);
  const [processingProgress, setProcessingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const scanningRef = useRef(false);

  const setScanning = useCallback((value: boolean) => {
    scanningRef.current = value;
    setIsScanning(value);
  }, []);

  const endScan = useCallback(() => {
    setScanning(false);
    setProcessingProgress(null);
  }, [setScanning]);

  const buildBatchSummaryMessage = useCallback(
    (successCount: number, failed: FailedScanItem[]): string => {
      const { failCount, failureReasonsByCode } =
        buildBatchFailureSummary(failed);
      const reasonParts = Object.entries(failureReasonsByCode)
        .map(([code, count]) =>
          t('home.scan.failureReasonCount', {
            label: getScanErrorMessage(code),
            count,
          })
        )
        .join('、');
      const reasonsLine =
        Object.keys(failureReasonsByCode).length > 0
          ? t('home.scan.failureReasonsPrefix') + reasonParts
          : '';
      return reasonsLine
        ? t('home.scan.doneSummaryWithReasons', {
            ok: successCount,
            fail: failCount,
            reasons: reasonsLine,
          })
        : t('home.scan.doneSummary', {
            ok: successCount,
            fail: failCount,
          });
    },
    []
  );

  const continueWithDrafts = useCallback(
    async (draftIds: string[]) => {
      await setScanReviewQueue(draftIds);
      endScan();
      router.push(`/scan-review/${draftIds[0]}` as any);
    },
    [endScan, router]
  );

  const runBatchScan = useCallback(async (uris: string[]): Promise<ScanOneResult[]> => {
    const total = uris.length;
    const results: ScanOneResult[] = [];
    for (let i = 0; i < uris.length; i++) {
      setProcessingProgress({ current: i + 1, total });
      const result = await runScanPipelineToReview(uris[i]!);
      results.push(result);
      if (!result.ok) {
        logger.warn('MultiScan', `image ${i + 1}/${total} failed`, {
          code: result.code,
          message: result.message,
        });
      }
    }
    setProcessingProgress(null);
    return results;
  }, []);

  const finalizeBatchOutcomeRef = useRef<
    (
      retryUris: string[],
      draftIds: string[],
      failed: FailedScanItem[],
      afterRetry: boolean
    ) => Promise<void>
  >(async () => undefined);

  const retryFailedImages = useCallback(
    (baseDraftIds: string[], failed: FailedScanItem[]) => {
      setScanning(true);
      void (async () => {
        try {
          const failedUris = failed.map((f) => f.uri);
          const results = await runBatchScan(failedUris);
          const draftIds = mergeDraftIdsAfterRetry(baseDraftIds, results);
          const stillFailed = collectFailedScanItems(failedUris, results);
          await finalizeBatchOutcomeRef.current(
            failedUris,
            draftIds,
            stillFailed,
            true
          );
        } catch (err: unknown) {
          logger.error('MultiScan', 'retryFailedImages error', err);
          endScan();
          Alert.alert(t('home.scan.error'), getScanErrorMessage('FAILED'));
        }
      })();
    },
    [endScan, runBatchScan, setScanning]
  );

  const retryAllImages = useCallback(
    (uris: string[]) => {
      setScanning(true);
      void (async () => {
        try {
          await clearScanReviewQueue();
          const results = await runBatchScan(uris);
          const draftIds = mergeDraftIdsAfterRetry([], results);
          const failed = collectFailedScanItems(uris, results);
          await finalizeBatchOutcomeRef.current(uris, draftIds, failed, true);
        } catch (err: unknown) {
          logger.error('MultiScan', 'retryAllImages error', err);
          endScan();
          Alert.alert(t('home.scan.error'), getScanErrorMessage('FAILED'));
        }
      })();
    },
    [endScan, runBatchScan, setScanning]
  );

  const finalizeBatchOutcome = useCallback(
    async (
      retryUris: string[],
      draftIds: string[],
      failed: FailedScanItem[],
      afterRetry: boolean
    ) => {
      if (failed.length === 0 && draftIds.length > 0) {
        await continueWithDrafts(draftIds);
        return;
      }

      if (draftIds.length > 0) {
        const prefix = afterRetry
          ? `${t('home.scan.partialRetryStillFailed')}\n\n`
          : '';
        const message =
          prefix + buildBatchSummaryMessage(draftIds.length, failed);
        endScan();
        Alert.alert(t('home.scan.partialTitle'), message, [
          {
            text: t('home.scan.continueSuccessful'),
            onPress: () => {
              void continueWithDrafts(draftIds);
            },
          },
          {
            text: t('home.scan.retryFailed'),
            onPress: () => retryFailedImages(draftIds, failed),
          },
        ]);
        return;
      }

      const message = buildBatchSummaryMessage(0, failed);
      endScan();
      Alert.alert(t('home.scan.allFailedTitle'), message, [
        {
          text: t('home.scan.cancel'),
          style: 'cancel',
          onPress: () => {
            void clearScanReviewQueue();
            endScan();
          },
        },
        {
          text: t('home.scan.retryAll'),
          onPress: () => retryAllImages(retryUris),
        },
      ]);
    },
    [
      buildBatchSummaryMessage,
      continueWithDrafts,
      endScan,
      retryAllImages,
      retryFailedImages,
    ]
  );
  finalizeBatchOutcomeRef.current = finalizeBatchOutcome;

  const processMultipleReceiptImages = useCallback(
    async (uris: string[]) => {
      try {
        await clearScanReviewQueue();
        const results = await runBatchScan(uris);
        const draftIds = mergeDraftIdsAfterRetry([], results);
        const failed = collectFailedScanItems(uris, results);
        await finalizeBatchOutcome(uris, draftIds, failed, false);
      } catch (err: unknown) {
        logger.error('MultiScan', 'Unexpected error', err);
        endScan();
        Alert.alert(t('home.scan.error'), getScanErrorMessage('FAILED'));
      }
    },
    [endScan, finalizeBatchOutcome, runBatchScan]
  );

  const processReceiptImageRef = useRef<(uri: string) => Promise<void>>(
    async () => undefined
  );

  const processReceiptImage = useCallback(
    async (uri: string) => {
      const t0 = Date.now();
      if (__DEV__) {
        console.log('[ScanTiming] ui_start_ms', { t0 });
      }

      const result = await runScanPipelineToReview(uri);
      if (!result.ok) {
        const code = result.code || 'FAILED';
        logger.warn('Scan', 'single scan failed', {
          code,
          message: result.message,
        });
        endScan();
        Alert.alert(
          t('home.scan.error'),
          `${getScanErrorMessage(code)}\n\n${t('home.scan.singleFailedMessage')}`,
          [
            { text: t('home.scan.cancel'), style: 'cancel' },
            {
              text: t('home.scan.retry'),
              onPress: () => {
                setScanning(true);
                void processReceiptImageRef.current(uri);
              },
            },
          ]
        );
        return;
      }

      if (result.kind !== 'review') {
        endScan();
        return;
      }

      await clearScanReviewQueue();
      await setScanReviewQueue([result.draftId]);
      endScan();
      if (__DEV__) {
        console.log('[ScanTiming] navigate_review_ms', { ms: Date.now() - t0 });
      }
      router.push(`/scan-review/${result.draftId}` as any);
    },
    [endScan, router, setScanning]
  );
  processReceiptImageRef.current = processReceiptImage;

  const launchReceiptScan = useCallback(() => {
    if (scanningRef.current) return;

    void (async () => {
      try {
        setScanning(true);

        if (__DEV__) {
          try {
            await probeSupabaseNetwork();
            await pingOcrEdge();
          } catch (pingError: unknown) {
            const message =
              pingError &&
              typeof pingError === 'object' &&
              'message' in pingError
                ? String((pingError as { message?: unknown }).message)
                : '';
            if (__DEV__ && message && !message.includes('not configured')) {
              console.warn('[OCR] Unexpected ping error:', message);
            }
          }
        }

        const sourceChoice = await new Promise<
          'camera' | 'album' | 'cancel'
        >((resolve) => {
          Alert.alert(
            t('home.scan.title'),
            '',
            [
              {
                text: t('home.scan.cancel'),
                style: 'cancel',
                onPress: () => resolve('cancel'),
              },
              {
                text: t('home.scan.takePhoto'),
                onPress: () => resolve('camera'),
              },
              {
                text: t('home.scan.chooseFromLibrary'),
                onPress: () => resolve('album'),
              },
            ],
            { cancelable: true, onDismiss: () => resolve('cancel') }
          );
        });

        if (sourceChoice === 'cancel') {
          setScanning(false);
          return;
        }

        if (sourceChoice === 'camera') {
          const { status: cameraStatus } =
            await ImagePicker.requestCameraPermissionsAsync();
          if (cameraStatus !== 'granted') {
            Alert.alert(
              t('permissions.cameraDeniedTitle'),
              t('permissions.cameraDeniedMessage')
            );
            setScanning(false);
            return;
          }

          const cameraResult = await ImagePicker.launchCameraAsync({
            mediaTypes: 'images',
            quality: 1,
            allowsEditing: false,
          });

          if (cameraResult.canceled) {
            setScanning(false);
            return;
          }

          const uri = cameraResult.assets[0]?.uri;
          if (!uri) {
            setScanning(false);
            return;
          }

          const confirmResult = await new Promise<boolean>((resolve) => {
            Alert.alert(
              t('home.scan.confirmTitle'),
              `${t('home.scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`,
              [
                {
                  text: t('home.scan.confirmCancel'),
                  style: 'cancel',
                  onPress: () => resolve(false),
                },
                {
                  text: t('home.scan.confirmAction'),
                  onPress: () => resolve(true),
                },
              ]
            );
          });

          if (!confirmResult) {
            setScanning(false);
            return;
          }

          await processReceiptImage(uri);
        } else if (sourceChoice === 'album') {
          const { status } =
            await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') {
            Alert.alert(
              t('permissions.libraryDeniedTitle'),
              t('permissions.libraryDeniedMessage')
            );
            setScanning(false);
            return;
          }

          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: 'images',
            quality: 1,
            allowsMultipleSelection: true,
            orderedSelection: true,
          });

          if (result.canceled) {
            setScanning(false);
            return;
          }

          const assets = result.assets || [];
          if (assets.length === 0) {
            setScanning(false);
            Alert.alert(t('home.scan.error'), t('home.scan.noImages'));
            return;
          }

          const confirmTitle =
            assets.length === 1
              ? t('home.scan.confirmTitle')
              : t('home.scan.confirmTitleMultiple', {
                  count: assets.length,
                });
          const confirmMessage = `${t('home.scan.confirmMessage')}\n\n${t('ocr.privacyNotice')}`;

          const confirmResult = await new Promise<boolean>((resolve) => {
            Alert.alert(confirmTitle, confirmMessage, [
              {
                text: t('home.scan.confirmCancel'),
                style: 'cancel',
                onPress: () => resolve(false),
              },
              {
                text: t('home.scan.confirmAction'),
                onPress: () => resolve(true),
              },
            ]);
          });

          if (!confirmResult) {
            setScanning(false);
            return;
          }

          if (assets.length === 1) {
            await processReceiptImage(assets[0]!.uri);
          } else {
            await processMultipleReceiptImages(assets.map((a) => a.uri));
          }
        }
      } catch (err: unknown) {
        logger.error('Home', 'Scan error', err);
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: unknown }).code || 'FAILED')
            : 'FAILED';
        Alert.alert(t('home.scan.error'), getScanErrorMessage(code));
        endScan();
      }
    })();
  }, [
    endScan,
    processMultipleReceiptImages,
    processReceiptImage,
    setScanning,
  ]);

  return {
    launchReceiptScan,
    isScanning,
    processingProgress,
  };
}
