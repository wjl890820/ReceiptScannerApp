import { shouldApplyPostSaveIdentityUpdate } from './postSaveSummaryIdentityLifecycle';

describe('postSaveSummaryIdentityLifecycle', () => {
  it('allows updates only for the current mounted receipt generation', () => {
    expect(
      shouldApplyPostSaveIdentityUpdate({
        mounted: true,
        capturedGeneration: 2,
        currentGeneration: 2,
        capturedReceiptId: 'receipt-a',
        currentReceiptId: 'receipt-a',
      })
    ).toBe(true);
  });

  it('blocks candidate load result for receipt A after route changes to receipt B', () => {
    expect(
      shouldApplyPostSaveIdentityUpdate({
        mounted: true,
        capturedGeneration: 1,
        currentGeneration: 2,
        capturedReceiptId: 'receipt-a',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('blocks confirmation feedback for receipt A after route changes to receipt B', () => {
    expect(
      shouldApplyPostSaveIdentityUpdate({
        mounted: true,
        capturedGeneration: 3,
        currentGeneration: 4,
        capturedReceiptId: 'receipt-a',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('blocks stale candidate refresh for receipt A after route changes to receipt B', () => {
    expect(
      shouldApplyPostSaveIdentityUpdate({
        mounted: true,
        capturedGeneration: 5,
        currentGeneration: 6,
        capturedReceiptId: 'receipt-a',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('blocks old finally processing reset after generation changes', () => {
    expect(
      shouldApplyPostSaveIdentityUpdate({
        mounted: true,
        capturedGeneration: 7,
        currentGeneration: 8,
        capturedReceiptId: 'receipt-b',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(false);
  });

  it('allows a new receipt generation after route changes', () => {
    expect(
      shouldApplyPostSaveIdentityUpdate({
        mounted: true,
        capturedGeneration: 9,
        currentGeneration: 9,
        capturedReceiptId: 'receipt-b',
        currentReceiptId: 'receipt-b',
      })
    ).toBe(true);
  });

  it('blocks state updates after unmount', () => {
    expect(
      shouldApplyPostSaveIdentityUpdate({
        mounted: false,
        capturedGeneration: 10,
        currentGeneration: 10,
        capturedReceiptId: 'receipt-a',
        currentReceiptId: 'receipt-a',
      })
    ).toBe(false);
  });
});
