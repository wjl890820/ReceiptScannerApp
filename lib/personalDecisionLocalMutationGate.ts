/**
 * Orders local personal-decision publication against cloud-restore materialization.
 * This is one JavaScript-runtime queue, not a SQLite lock and not cloud sync.
 */

let tail: Promise<void> = Promise.resolve();

export async function withPersonalDecisionLocalMutationGate<T>(
  operation: () => Promise<T>
): Promise<T> {
  const previous = tail;
  let release: () => void = () => undefined;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
  } catch {
    // A rejected predecessor must not stick the queue.
  }
  try {
    return await operation();
  } finally {
    release();
  }
}
