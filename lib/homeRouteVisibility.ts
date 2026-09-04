/**
 * Expo Router pathnames that mean the Home tab is the visible leaf.
 * Used so root-stack returns (/shopping-list, /product/…) re-trigger Home refresh
 * even when tab-level useFocusEffect is unreliable.
 */
export function isHomeRoutePath(pathname: string | null | undefined): boolean {
  if (pathname == null) return false;
  const path = pathname.trim();
  if (!path || path === '/') return path === '/';
  if (path === '/index') return true;
  if (path === '/(tabs)' || path === '/(tabs)/' || path === '/(tabs)/index') {
    return true;
  }
  return false;
}
