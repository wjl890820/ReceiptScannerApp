/**
 * OCR Edge transport seam. The mock records Expo fetch and delegates to global fetch
 * so existing response fixtures stay in one place.
 */
import fs from 'fs';
import path from 'path';

jest.mock('expo/fetch', () => ({
  fetch: jest.fn((...args: unknown[]) =>
    (globalThis as { fetch?: (...call: unknown[]) => unknown }).fetch?.(...args)
  ),
}));

import { fetch as expoFetch } from 'expo/fetch';

import { fetchOcrEdge } from './ocrEdgeTransport';

const H3_FILES = [
  'lib/db.ts',
  'lib/merchantScopeGeneration.ts',
  'lib/merchantScopeGeneration.test.ts',
  'lib/merchantScopeIdentityReadPath.test.ts',
  'lib/merchantScopeSaveActivation.test.ts',
  'lib/productIdentityConsumer.ts',
  'lib/productIdentityResolver.ts',
  'lib/productPriceHistory.ts',
  'lib/personalProductEndpointInventory.ts',
  'lib/productHistory.ts',
  'lib/repeatProductProfile.ts',
  'lib/engagementMilestones.ts',
  'lib/cloudBackupPayload.ts',
  'lib/cloudRestore.ts',
  'lib/cloudRestorePayload.ts',
  'supabase/migrations/011_merchant_scope_generation.sql',
];

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

describe('ocr edge transport', () => {
  beforeEach(() => {
    (expoFetch as jest.Mock).mockClear();
  });

  it('sends one Expo fetch POST and returns the body for the caller to parse', async () => {
    const body = JSON.stringify({ success: true, analysis: { total: 1 } });
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => body,
    }));

    const response = await fetchOcrEdge('https://example.supabase.co/functions/v1/ocr-receipt-v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: 'sb_publishable_test',
        Authorization: 'Bearer user-token',
        'x-device-id': 'device-test',
      },
      body: '{"ping":true}',
    });
    const parsed = JSON.parse(await response.text()) as { success: boolean };

    expect(parsed.success).toBe(true);
    expect(response.status).toBe(200);
    expect(expoFetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (expoFetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('/functions/v1/ocr-receipt-v2');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('sb_publishable_test');
    expect(init.headers.Authorization).toBe('Bearer user-token');
    expect(init.headers['x-device-id']).toBe('device-test');
    expect(init.body).toBe('{"ping":true}');
  });

  it('does not issue another POST when the caller cannot read the body', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('Unable to resolve data for blob: test-blob');
      },
    }));

    const response = await fetchOcrEdge('https://example.supabase.co/functions/v1/ocr-receipt-v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    await expect(response.text()).rejects.toThrow(/Unable to resolve data for blob/);
    expect(expoFetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('routes production ocr-receipt-v2 reads through the Expo transport and leaves the probe on global fetch', () => {
    const analyzer = source('lib/receiptAnalyzer.ts');
    const service = source('lib/ocrService.ts');
    const transport = source('lib/ocrEdgeTransport.ts');

    expect(transport).toContain("import { fetch as expoFetch } from 'expo/fetch'");
    expect(transport).toContain('return expoFetch(url, init)');
    expect(analyzer).toContain('fetchOcrEdge(edgeFunctionUrl');
    expect(analyzer).not.toContain('await fetch(edgeFunctionUrl');
    expect(service).toContain('fetchOcrEdge(edgeFunctionUrl');
    expect(service).not.toContain('await fetch(edgeFunctionUrl');
    expect(service).toContain('await fetch(probeUrl');
    expect(analyzer.match(/fetchOcrEdge\(edgeFunctionUrl/g)).toHaveLength(1);
    expect(service.match(/fetchOcrEdge\(edgeFunctionUrl/g)).toHaveLength(2);
  });

  it('does not touch merchant-scope or save files', () => {
    for (const file of H3_FILES) {
      const text = source(file);
      expect(text).not.toContain('ocrEdgeTransport');
      expect(text).not.toContain("from 'expo/fetch'");
    }
  });
});
