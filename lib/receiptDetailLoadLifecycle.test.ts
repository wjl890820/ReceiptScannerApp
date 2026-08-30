import { shouldApplyReceiptDetailLoadUpdate } from './receiptDetailLoadLifecycle';

describe('receiptDetailLoadLifecycle', () => {
  it('A. route A cannot apply after route B starts', () => {
    expect(
      shouldApplyReceiptDetailLoadUpdate({
        mounted: true,
        capturedGeneration: 1,
        currentGeneration: 2,
        capturedReceiptId: 'receipt-a',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('B. stale A rejection cannot apply after route B starts', () => {
    expect(
      shouldApplyReceiptDetailLoadUpdate({
        mounted: true,
        capturedGeneration: 3,
        currentGeneration: 4,
        capturedReceiptId: 'receipt-a',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('C. stale A finally cannot clear B loading', () => {
    expect(
      shouldApplyReceiptDetailLoadUpdate({
        mounted: true,
        capturedGeneration: 5,
        currentGeneration: 6,
        capturedReceiptId: 'receipt-b',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('D. unmount invalidates pending request', () => {
    expect(
      shouldApplyReceiptDetailLoadUpdate({
        mounted: false,
        capturedGeneration: 7,
        currentGeneration: 7,
        capturedReceiptId: 'receipt-b',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('E. latest current route request can apply', () => {
    expect(
      shouldApplyReceiptDetailLoadUpdate({
        mounted: true,
        capturedGeneration: 8,
        currentGeneration: 8,
        capturedReceiptId: 'receipt-b',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(true);
  });
});
