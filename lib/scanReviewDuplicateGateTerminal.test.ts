import {
  executeDuplicateGateTerminalFlow,
  terminateDuplicateScanReviewDraft,
  type DuplicateGateTerminalFlowDeps,
} from './scanReviewDuplicateGateTerminal';

function makeFlowDeps(
  overrides: Partial<DuplicateGateTerminalFlowDeps> = {}
) {
  const order: string[] = [];
  const revalidateDestination = jest.fn(async () => {
    order.push('revalidate');
    return true;
  });
  const terminateDraft = jest.fn(async () => {
    order.push('terminate');
    return { ok: true as const, nextDraftId: 'draft-b', queueClean: true };
  });
  const clearPendingPersistence = jest.fn(() => {
    order.push('clear');
  });
  const allowLeave = jest.fn(() => {
    order.push('leave');
  });
  const replaceWithHistory = jest.fn(() => {
    order.push('replace');
  });
  const isStillCurrent = jest.fn(() => true);

  return {
    order,
    revalidateDestination,
    terminateDraft,
    clearPendingPersistence,
    allowLeave,
    replaceWithHistory,
    isStillCurrent,
    ...overrides,
  };
}

describe('executeDuplicateGateTerminalFlow', () => {
  const input = {
    currentDraftId: 'draft-a',
    existingReceiptId: 'receipt-saved',
  };

  it('enforces ownership success order: revalidate → terminate → clear → leave → replace', async () => {
    const deps = makeFlowDeps();

    await expect(executeDuplicateGateTerminalFlow(input, deps)).resolves.toEqual({
      status: 'completed',
    });

    expect(deps.order).toEqual([
      'revalidate',
      'terminate',
      'clear',
      'leave',
      'replace',
    ]);
    expect(deps.revalidateDestination).toHaveBeenCalledWith('receipt-saved');
    expect(deps.terminateDraft).toHaveBeenCalledWith('draft-a');
    expect(deps.replaceWithHistory).toHaveBeenCalledWith('receipt-saved');
  });

  it('fails closed on ownership failure without destructive side effects', async () => {
    const order: string[] = [];
    const deps = makeFlowDeps({
      revalidateDestination: jest.fn(async () => {
        order.push('revalidate');
        return false;
      }),
    });

    await expect(executeDuplicateGateTerminalFlow(input, deps)).resolves.toEqual({
      status: 'ownership_failed',
    });

    expect(order).toEqual(['revalidate']);
    expect(deps.terminateDraft).not.toHaveBeenCalled();
    expect(deps.clearPendingPersistence).not.toHaveBeenCalled();
    expect(deps.allowLeave).not.toHaveBeenCalled();
    expect(deps.replaceWithHistory).not.toHaveBeenCalled();
  });

  it('fails closed on termination failure without clearing persistence or navigating', async () => {
    const deps = makeFlowDeps({
      terminateDraft: jest.fn(async () => {
        deps.order.push('terminate');
        return { ok: false as const, reason: 'remove_failed' as const };
      }),
    });

    await expect(executeDuplicateGateTerminalFlow(input, deps)).resolves.toEqual({
      status: 'termination_failed',
    });

    expect(deps.order).toEqual(['revalidate', 'terminate']);
    expect(deps.clearPendingPersistence).not.toHaveBeenCalled();
    expect(deps.allowLeave).not.toHaveBeenCalled();
    expect(deps.replaceWithHistory).not.toHaveBeenCalled();
  });

  it('replaces with the revalidated existing receipt id, never the transient draft id', async () => {
    const deps = makeFlowDeps();

    await executeDuplicateGateTerminalFlow(input, deps);

    expect(deps.replaceWithHistory).toHaveBeenCalledWith('receipt-saved');
    expect(deps.replaceWithHistory).not.toHaveBeenCalledWith('draft-a');
  });

  it('clears persistence only after successful termination and before navigation', async () => {
    const order: string[] = [];
    const deps = makeFlowDeps({
      revalidateDestination: jest.fn(async () => {
        order.push('revalidate');
        return true;
      }),
      terminateDraft: jest.fn(async () => {
        order.push('terminate');
        return { ok: true as const, nextDraftId: 'draft-b', queueClean: true };
      }),
      clearPendingPersistence: jest.fn(() => {
        order.push('clear');
      }),
      allowLeave: jest.fn(() => {
        order.push('leave');
      }),
      replaceWithHistory: jest.fn(() => {
        order.push('replace');
      }),
    });

    await executeDuplicateGateTerminalFlow(input, deps);

    expect(order).toEqual(['revalidate', 'terminate', 'clear', 'leave', 'replace']);
    expect(order.indexOf('terminate')).toBeLessThan(order.indexOf('clear'));
    expect(order.indexOf('clear')).toBeLessThan(order.indexOf('replace'));
  });

  it('enables leave only after successful termination and before navigation', async () => {
    const order: string[] = [];
    const deps = makeFlowDeps({
      revalidateDestination: jest.fn(async () => {
        order.push('revalidate');
        return true;
      }),
      terminateDraft: jest.fn(async () => {
        order.push('terminate');
        return { ok: true as const, nextDraftId: 'draft-b', queueClean: true };
      }),
      clearPendingPersistence: jest.fn(() => {
        order.push('clear');
      }),
      allowLeave: jest.fn(() => {
        order.push('leave');
      }),
      replaceWithHistory: jest.fn(() => {
        order.push('replace');
      }),
    });

    await executeDuplicateGateTerminalFlow(input, deps);

    expect(order).toEqual(['revalidate', 'terminate', 'clear', 'leave', 'replace']);
    expect(order.indexOf('terminate')).toBeLessThan(order.indexOf('leave'));
    expect(order.indexOf('leave')).toBeLessThan(order.indexOf('replace'));
  });

  it('reports navigation failure after terminal completion without retrying termination', async () => {
    const navigationError = new Error('replace failed');
    const deps = makeFlowDeps({
      replaceWithHistory: jest.fn(() => {
        deps.order.push('replace');
        throw navigationError;
      }),
    });

    await expect(executeDuplicateGateTerminalFlow(input, deps)).resolves.toEqual({
      status: 'completed_navigation_failed',
      error: navigationError,
    });

    expect(deps.order).toEqual([
      'revalidate',
      'terminate',
      'clear',
      'leave',
      'replace',
    ]);
    expect(deps.terminateDraft).toHaveBeenCalledTimes(1);
    expect(deps.clearPendingPersistence).toHaveBeenCalledTimes(1);
    expect(deps.allowLeave).toHaveBeenCalledTimes(1);
  });

  it('still completes terminal flow when queue cleanup is degraded but draft deletion succeeded', async () => {
    const deps = makeFlowDeps({
      terminateDraft: jest.fn(async () => ({
        ok: true as const,
        nextDraftId: 'draft-b',
        queueClean: false,
      })),
    });

    await expect(executeDuplicateGateTerminalFlow(input, deps)).resolves.toEqual({
      status: 'completed',
    });

    expect(deps.replaceWithHistory).toHaveBeenCalledWith('receipt-saved');
  });

  it('blocks destructive termination when the route is no longer current before deletion', async () => {
    const deps = makeFlowDeps({
      isStillCurrent: jest
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
    });

    await expect(executeDuplicateGateTerminalFlow(input, deps)).resolves.toEqual({
      status: 'stale',
    });

    expect(deps.revalidateDestination).toHaveBeenCalledTimes(1);
    expect(deps.terminateDraft).not.toHaveBeenCalled();
    expect(deps.clearPendingPersistence).not.toHaveBeenCalled();
    expect(deps.allowLeave).not.toHaveBeenCalled();
    expect(deps.replaceWithHistory).not.toHaveBeenCalled();
  });

  it('blocks post-termination side effects when the route becomes stale after deletion', async () => {
    const deps = makeFlowDeps({
      isStillCurrent: jest
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
    });

    await expect(executeDuplicateGateTerminalFlow(input, deps)).resolves.toEqual({
      status: 'stale',
    });

    expect(deps.terminateDraft).toHaveBeenCalledTimes(1);
    expect(deps.clearPendingPersistence).not.toHaveBeenCalled();
    expect(deps.allowLeave).not.toHaveBeenCalled();
    expect(deps.replaceWithHistory).not.toHaveBeenCalled();
  });
});

describe('terminateDuplicateScanReviewDraft', () => {
  it('removes only the current draft and preserves other queued drafts', async () => {
    const removeDraft = jest.fn(async () => undefined);
    const advanceQueue = jest.fn(async (removedDraftId: string) => {
      expect(removedDraftId).toBe('draft-a');
      return 'draft-b';
    });

    await expect(
      terminateDuplicateScanReviewDraft('draft-a', {
        removeDraft,
        advanceQueue,
      })
    ).resolves.toEqual({ ok: true, nextDraftId: 'draft-b', queueClean: true });

    expect(removeDraft).toHaveBeenCalledTimes(1);
    expect(removeDraft).toHaveBeenCalledWith('draft-a');
    expect(advanceQueue).toHaveBeenCalledWith('draft-a');
  });

  it('retries draft removal conservatively before failing closed', async () => {
    const removeDraft = jest
      .fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);
    const advanceQueue = jest.fn(async () => 'draft-b');

    await expect(
      terminateDuplicateScanReviewDraft('draft-a', {
        removeDraft,
        advanceQueue,
        maxAttempts: 3,
      })
    ).resolves.toEqual({ ok: true, nextDraftId: 'draft-b', queueClean: true });

    expect(removeDraft).toHaveBeenCalledTimes(3);
    expect(advanceQueue).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the draft cannot be removed', async () => {
    const removeDraft = jest.fn(async () => {
      throw new Error('remove failed');
    });
    const advanceQueue = jest.fn(async () => 'draft-b');

    await expect(
      terminateDuplicateScanReviewDraft('draft-a', {
        removeDraft,
        advanceQueue,
        maxAttempts: 2,
      })
    ).resolves.toEqual({ ok: false, reason: 'remove_failed' });

    expect(removeDraft).toHaveBeenCalledTimes(2);
    expect(advanceQueue).not.toHaveBeenCalled();
  });

  it('reports degraded queue cleanup without failing terminal deletion', async () => {
    const removeDraft = jest.fn(async () => undefined);
    const advanceQueue = jest.fn(async () => {
      throw new Error('queue write failed');
    });

    await expect(
      terminateDuplicateScanReviewDraft('draft-a', {
        removeDraft,
        advanceQueue,
      })
    ).resolves.toEqual({ ok: true, nextDraftId: null, queueClean: false });
  });
});
