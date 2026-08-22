/**
 * Conservative back navigation for detail screens without a native header.
 * Prefer router.back() when a stack entry exists; otherwise fall back to History
 * so deep-linked users are not trapped.
 */
export const HISTORY_TAB_FALLBACK_HREF = '/history' as const;

export type BackCapableRouter = {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: typeof HISTORY_TAB_FALLBACK_HREF) => void;
};

export function navigateBackOrHistory(router: BackCapableRouter): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(HISTORY_TAB_FALLBACK_HREF);
}
