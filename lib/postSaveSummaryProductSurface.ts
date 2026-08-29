import type { PersonalIdentityConfirmationFeedback } from './personalProductIdentityConfirmationCoordinator';
import type { PersonalIdentityPromptCandidateV1 } from './personalProductIdentityCandidateService';
import type { PostSavePurchaseMemory } from './postSavePurchaseMemory';

export type PostSaveProductSurface =
  | 'identity_feedback'
  | 'identity_candidate'
  | 'purchase_memory'
  | 'loading'
  | 'none';

export function shouldLoadPostSavePurchaseMemory(input: {
  hasIdentityFeedback: boolean;
  g4CandidateStatus: 'candidate' | 'none' | string;
}): boolean {
  if (input.hasIdentityFeedback) return false;
  return input.g4CandidateStatus === 'none';
}

export function resolvePostSaveProductSurface(input: {
  identityFeedback: PersonalIdentityConfirmationFeedback | null;
  identityCandidate: PersonalIdentityPromptCandidateV1 | null;
  purchaseMemory: PostSavePurchaseMemory | null;
  loading: boolean;
}): PostSaveProductSurface {
  if (input.identityFeedback) return 'identity_feedback';
  if (input.identityCandidate) return 'identity_candidate';
  if (input.purchaseMemory) return 'purchase_memory';
  if (input.loading) return 'loading';
  return 'none';
}
