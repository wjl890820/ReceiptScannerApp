/**
 * Build 53 — conservative back navigation for custom-header detail screens.
 *
 * Prefer native stack unwind (router.back / canGoBack) so History → Detail → Back
 * returns to History, Home → Product → Back returns to Home, etc.
 *
 * Fallback is ONLY for deep links / missing stack history — never hardcode Home
 * as the normal in-app detail back target.
 */

export const HISTORY_TAB_FALLBACK_HREF = '/history' as const;
export const HOME_TAB_FALLBACK_HREF = '/' as const;
export const SETTINGS_TAB_FALLBACK_HREF = '/settings' as const;

export type BackCapableRouter = {
  canGoBack: () => boolean;
  back: () => void;
  // Expo Router's replace is typed to Href; keep this loose for shared helpers.
  replace: (href: any) => void;
};

export function navigateBackOrFallback(
  router: BackCapableRouter,
  fallbackHref: string
): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallbackHref);
}

/** Receipt Detail / History-origin deep links. */
export function navigateBackOrHistory(router: BackCapableRouter): void {
  navigateBackOrFallback(router, HISTORY_TAB_FALLBACK_HREF);
}

/** Product Detail: prefer stack parent; deep-link fallback lands on Home. */
export function navigateBackOrHome(router: BackCapableRouter): void {
  navigateBackOrFallback(router, HOME_TAB_FALLBACK_HREF);
}

/** Settings subordinate pages. */
export function navigateBackOrSettings(router: BackCapableRouter): void {
  navigateBackOrFallback(router, SETTINGS_TAB_FALLBACK_HREF);
}
