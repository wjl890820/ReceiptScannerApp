import {
  reduceTerminalDuplicateDestinationId,
  resolveScanReviewDuplicateTerminalUiPhase,
  shouldAllowTerminalRecoveryNavigationRetry,
  shouldHideDuplicateGateSaveBar,
  shouldShowDuplicateTerminalRecovery,
  shouldShowUnresolvedDuplicateGate,
  type DuplicateGateTerminalFlowResult,
} from './scanReviewDuplicateGateTerminal';

describe('scanReview duplicate terminal UI state', () => {
  it('marks review terminally completed after completed_navigation_failed', () => {
    expect(
      reduceTerminalDuplicateDestinationId(null, {
        result: { status: 'completed_navigation_failed', error: new Error('nav') },
        existingReceiptId: 'receipt-saved',
      })
    ).toBe('receipt-saved');
    expect(
      resolveScanReviewDuplicateTerminalUiPhase({
        terminalDuplicateDestinationId: 'receipt-saved',
      })
    ).toBe('recoverable_terminal_navigation');
  });

  it('keeps unresolved review after ownership_failed', () => {
    expect(
      reduceTerminalDuplicateDestinationId(null, {
        result: { status: 'ownership_failed' },
        existingReceiptId: 'receipt-saved',
      })
    ).toBeNull();
    expect(
      shouldShowUnresolvedDuplicateGate({
        showDuplicateGate: true,
        terminalDuplicateDestinationId: null,
      })
    ).toBe(true);
  });

  it('keeps unresolved review after termination_failed', () => {
    expect(
      reduceTerminalDuplicateDestinationId(null, {
        result: { status: 'termination_failed' },
        existingReceiptId: 'receipt-saved',
      })
    ).toBeNull();
    expect(
      shouldShowDuplicateTerminalRecovery({
        terminalDuplicateDestinationId: null,
      })
    ).toBe(false);
  });

  it('does not enter terminal recovery after normal completed navigation', () => {
    expect(
      reduceTerminalDuplicateDestinationId(null, {
        result: { status: 'completed' },
        existingReceiptId: 'receipt-saved',
      })
    ).toBeNull();
  });

  it('hides SaveBar and unresolved gate during terminal recovery', () => {
    const input = {
      showDuplicateGate: true,
      terminalDuplicateDestinationId: 'receipt-saved',
    };
    expect(shouldShowUnresolvedDuplicateGate(input)).toBe(false);
    expect(shouldShowDuplicateTerminalRecovery(input)).toBe(true);
    expect(shouldHideDuplicateGateSaveBar(input)).toBe(true);
  });

  it('allows navigation retry only while a terminal destination exists and idle', () => {
    expect(
      shouldAllowTerminalRecoveryNavigationRetry({
        terminalDuplicateDestinationId: 'receipt-saved',
        processing: false,
      })
    ).toBe(true);
    expect(
      shouldAllowTerminalRecoveryNavigationRetry({
        terminalDuplicateDestinationId: 'receipt-saved',
        processing: true,
      })
    ).toBe(false);
    expect(
      shouldAllowTerminalRecoveryNavigationRetry({
        terminalDuplicateDestinationId: null,
        processing: false,
      })
    ).toBe(false);
  });

  it('does not transition terminal recovery back to unresolved when coordinator fails again', () => {
    const current = 'receipt-saved';
    expect(
      reduceTerminalDuplicateDestinationId(current, {
        result: { status: 'termination_failed' },
        existingReceiptId: 'receipt-saved',
      })
    ).toBe(current);
    expect(
      reduceTerminalDuplicateDestinationId(current, {
        result: { status: 'ownership_failed' },
        existingReceiptId: 'receipt-saved',
      })
    ).toBe(current);
  });
});

describe('scanReview duplicate terminal coordinator result mapping', () => {
  const results: DuplicateGateTerminalFlowResult[] = [
    { status: 'stale' },
    { status: 'ownership_failed' },
    { status: 'termination_failed' },
    { status: 'completed' },
    { status: 'completed_navigation_failed', error: new Error('nav') },
  ];

  it('only completed_navigation_failed enters terminal recovery', () => {
    for (const result of results) {
      const next = reduceTerminalDuplicateDestinationId(null, {
        result,
        existingReceiptId: 'receipt-saved',
      });
      if (result.status === 'completed_navigation_failed') {
        expect(next).toBe('receipt-saved');
      } else {
        expect(next).toBeNull();
      }
    }
  });
});
