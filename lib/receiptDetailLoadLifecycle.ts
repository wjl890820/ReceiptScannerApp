export type ReceiptDetailLoadUpdateContext = {
  mounted: boolean;
  capturedGeneration: number;
  currentGeneration: number;
  capturedReceiptId: string;
  currentReceiptId: string | null | undefined;
};

export function shouldApplyReceiptDetailLoadUpdate(
  context: ReceiptDetailLoadUpdateContext
): boolean {
  if (!context.mounted) return false;
  if (context.capturedGeneration !== context.currentGeneration) return false;
  if (!context.capturedReceiptId || !context.currentReceiptId) return false;
  return context.capturedReceiptId === context.currentReceiptId;
}
