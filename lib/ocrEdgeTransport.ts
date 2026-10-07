import { fetch as expoFetch } from 'expo/fetch';

/**
 * One POST to the OCR Edge Function.
 *
 * Expo fetch reads the JSON body without the React Native Blob bridge.
 * Callers must not send a second request when reading the body fails.
 */
export function fetchOcrEdge(
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string }
): Promise<Response> {
  return expoFetch(url, init);
}
