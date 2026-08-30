export function beginAsyncRequestGeneration(generationRef: {
  current: number;
}): number {
  return ++generationRef.current;
}

export function invalidateAsyncRequestGeneration(generationRef: {
  current: number;
}): number {
  return ++generationRef.current;
}

export function shouldApplyAsyncRequestGeneration(
  capturedGeneration: number,
  currentGeneration: number
): boolean {
  return capturedGeneration === currentGeneration;
}
