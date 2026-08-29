import { resolvePostSaveProductSurface, shouldLoadPostSavePurchaseMemory } from './postSaveSummaryProductSurface';

describe('postSaveSummaryProductSurface', () => {
  it('loads G5 memory only when G4 candidate is none and no feedback exists', () => {
    expect(
      shouldLoadPostSavePurchaseMemory({
        hasIdentityFeedback: false,
        g4CandidateStatus: 'none',
      })
    ).toBe(true);
    expect(
      shouldLoadPostSavePurchaseMemory({
        hasIdentityFeedback: true,
        g4CandidateStatus: 'none',
      })
    ).toBe(false);
    expect(
      shouldLoadPostSavePurchaseMemory({
        hasIdentityFeedback: false,
        g4CandidateStatus: 'candidate',
      })
    ).toBe(false);
  });

  it('prefers identity feedback over candidate and memory', () => {
    expect(
      resolvePostSaveProductSurface({
        identityFeedback: {
          kind: 'history_unlocked',
          target: null,
          purchaseOccurrenceCount: null,
          merchantCount: null,
        },
        identityCandidate: { savedReceiptId: 'a' } as never,
        purchaseMemory: { savedReceiptId: 'a' } as never,
        loading: false,
      })
    ).toBe('identity_feedback');
  });

  it('prefers identity candidate over purchase memory', () => {
    expect(
      resolvePostSaveProductSurface({
        identityFeedback: null,
        identityCandidate: { savedReceiptId: 'a' } as never,
        purchaseMemory: { savedReceiptId: 'a' } as never,
        loading: false,
      })
    ).toBe('identity_candidate');
  });

  it('shows purchase memory only when candidate and feedback are absent', () => {
    expect(
      resolvePostSaveProductSurface({
        identityFeedback: null,
        identityCandidate: null,
        purchaseMemory: { savedReceiptId: 'a' } as never,
        loading: false,
      })
    ).toBe('purchase_memory');
  });

  it('shows loading when no surface is ready yet', () => {
    expect(
      resolvePostSaveProductSurface({
        identityFeedback: null,
        identityCandidate: null,
        purchaseMemory: null,
        loading: true,
      })
    ).toBe('loading');
  });
});
