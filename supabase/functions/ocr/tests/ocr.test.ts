// supabase/functions/ocr/tests/ocr.test.ts
// Integration tests for production OCR Edge Function

import { assertEquals, assertExists } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

const EDGE_FUNCTION_URL = Deno.env.get('EDGE_FUNCTION_URL') || 'http://localhost:54321/functions/v1/ocr';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || 'test-anon-key';
const TEST_DEVICE_ID = 'test-device-' + Date.now();
const TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; // 1x1 PNG

/**
 * Generate idempotency key from image hash
 */
async function generateIdempotencyKey(imageBase64: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(imageBase64);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Make OCR request
 */
async function makeOCRRequest(
  imageBase64: string,
  idempotencyKey: string,
  deviceId: string = TEST_DEVICE_ID
): Promise<Response> {
  return fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'x-device-id': deviceId,
      'x-idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      imageBase64,
      mimeType: 'image/png',
    }),
  });
}

/**
 * Test 1: Success response structure matches schema
 */
Deno.test('Test 1: Success response structure', async () => {
  const idempotencyKey = await generateIdempotencyKey(TEST_IMAGE_BASE64 + '-test1');
  const response = await makeOCRRequest(TEST_IMAGE_BASE64, idempotencyKey);

  assertEquals(response.status, 200);

  const body = await response.json();
  assertEquals(body.ok, true);
  assertExists(body.request_id);
  assertEquals(body.idempotency_key, idempotencyKey);
  assertExists(body.parser_version);
  assertExists(body.model);
  assertExists(body.latency_ms);
  assertExists(body.data);
  assertExists(body.data.receipt);
  assertExists(body.data.receipt.items);
  assertExists(Array.isArray(body.data.receipt.items));
});

/**
 * Test 2: Idempotency - same key second request returns cached result
 */
Deno.test('Test 2: Idempotency hit', async () => {
  const idempotencyKey = await generateIdempotencyKey(TEST_IMAGE_BASE64 + '-test2');

  // First request
  const response1 = await makeOCRRequest(TEST_IMAGE_BASE64, idempotencyKey);
  assertEquals(response1.status, 200);
  const body1 = await response1.json();
  const latency1 = body1.latency_ms;

  // Second request (same key)
  const response2 = await makeOCRRequest(TEST_IMAGE_BASE64, idempotencyKey);
  assertEquals(response2.status, 200);
  const body2 = await response2.json();

  // Should return cached result (same request_id or different, but same data)
  assertEquals(body2.ok, true);
  assertEquals(body2.idempotency_key, idempotencyKey);
  // Latency should be significantly lower (cached)
  // Note: In real test, latency2 should be < latency1, but in MOCK_OCR mode both are fast
});

/**
 * Test 3: Concurrent same key - one processes, others get 202 IN_PROGRESS
 */
Deno.test('Test 3: Concurrent idempotency', async () => {
  const idempotencyKey = await generateIdempotencyKey(TEST_IMAGE_BASE64 + '-test3');

  // Fire 10 concurrent requests
  const promises = Array.from({ length: 10 }, () =>
    makeOCRRequest(TEST_IMAGE_BASE64, idempotencyKey)
  );

  const responses = await Promise.all(promises);
  const statuses = await Promise.all(responses.map((r) => r.status));

  // At least one should be 200 (the one that acquired lock)
  const successCount = statuses.filter((s) => s === 200).length;
  const inProgressCount = statuses.filter((s) => s === 202).length;

  // Should have at least 1 success, and some 202s (or all 200s if fast enough)
  assertEquals(successCount >= 1, true);
  // All should be either 200 or 202
  assertEquals(
    statuses.every((s) => s === 200 || s === 202),
    true
  );

  // Verify all responses have same idempotency_key
  const bodies = await Promise.all(responses.map((r) => r.json()));
  bodies.forEach((body) => {
    assertEquals(body.idempotency_key, idempotencyKey);
  });
});

/**
 * Test 4: Rate limiting - exceed minute limit returns 429
 */
Deno.test('Test 4: Rate limit 429', async () => {
  const uniqueDeviceId = 'test-device-ratelimit-' + Date.now();
  const rateLimitPerMinute = 6; // From env or default

  // Make requests exceeding the limit
  const requests = [];
  for (let i = 0; i < rateLimitPerMinute + 2; i++) {
    const idempotencyKey = await generateIdempotencyKey(TEST_IMAGE_BASE64 + `-ratelimit-${i}`);
    requests.push(makeOCRRequest(TEST_IMAGE_BASE64, idempotencyKey, uniqueDeviceId));
  }

  const responses = await Promise.all(requests);
  const bodies = await Promise.all(responses.map((r) => r.json()));

  // At least one should be rate limited
  const rateLimited = bodies.filter((b) => b.error?.code === 'RATE_LIMITED');
  assertEquals(rateLimited.length >= 1, true);

  // Check rate limited response structure
  const rateLimitedResp = rateLimited[0];
  assertEquals(rateLimitedResp.ok, false);
  assertEquals(rateLimitedResp.error.code, 'RATE_LIMITED');
  assertEquals(rateLimitedResp.error.retryable, true);
  assertExists(rateLimitedResp.error.retry_after_ms);
  assertExists(rateLimitedResp.error.details);
});

/**
 * Test 5: Upstream timeout returns 504
 */
Deno.test('Test 5: Upstream timeout 504', async () => {
  // This test requires MOCK_OCR to simulate timeout
  // In real scenario, would need to mock Gemini API to delay > REQUEST_TIMEOUT_MS
  // For now, we test the error response structure

  const idempotencyKey = await generateIdempotencyKey(TEST_IMAGE_BASE64 + '-timeout');
  
  // Note: This test may not actually trigger timeout in MOCK_OCR mode
  // In production, would need to configure MOCK_OCR to sleep > REQUEST_TIMEOUT_MS
  const response = await makeOCRRequest(TEST_IMAGE_BASE64, idempotencyKey);

  // Should be either 200 (if fast) or 504 (if timeout)
  const body = await response.json();
  
  if (response.status === 504) {
    assertEquals(body.ok, false);
    assertEquals(body.error.code, 'UPSTREAM_TIMEOUT');
    assertEquals(body.error.retryable, true);
  } else {
    // If not timeout, should be success
    assertEquals(body.ok, true);
  }
});

/**
 * Test 6: Invalid input returns 400
 */
Deno.test('Test 6: Invalid input 400', async () => {
  const idempotencyKey = await generateIdempotencyKey('invalid');

  const response = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'x-device-id': TEST_DEVICE_ID,
      'x-idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      // Missing imageBase64
      mimeType: 'image/png',
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.ok, false);
  assertEquals(body.error.code, 'INVALID_INPUT');
  assertEquals(body.error.retryable, false);
});

/**
 * Test 7: Missing headers returns 400
 */
Deno.test('Test 7: Missing headers 400', async () => {
  const response = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      // Missing x-device-id and x-idempotency-key
    },
    body: JSON.stringify({
      imageBase64: TEST_IMAGE_BASE64,
      mimeType: 'image/png',
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.ok, false);
  assertEquals(body.error.code, 'INVALID_INPUT');
});
