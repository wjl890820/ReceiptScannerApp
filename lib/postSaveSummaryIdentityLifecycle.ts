export type PostSaveIdentityUpdateContext = {
  mounted: boolean;
  capturedGeneration: number;
  currentGeneration: number;
  capturedReceiptId: string | null;
  currentReceiptId: string | null;
};

export function shouldApplyPostSaveIdentityUpdate(
  context: PostSaveIdentityUpdateContext
): boolean {
  if (!context.mounted) return false;
  if (context.capturedGeneration !== context.currentGeneration) return false;
  if (context.capturedReceiptId == null || context.currentReceiptId == null) {
    return false;
  }
  return context.capturedReceiptId === context.currentReceiptId;
}
