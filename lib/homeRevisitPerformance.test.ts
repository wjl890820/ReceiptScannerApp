import * as fs from 'fs';
import * as path from 'path';

import {
  beginHomeRefresh,
  completeHomeRefresh,
  failHomeRefresh,
  INITIAL_HOME_REFRESH_STATE,
  isLatestHomeRefresh,
} from './homeRefreshState';

describe('Home revisit refresh state', () => {
  it('allows blocking loading only before the first complete snapshot', () => {
    const cold = beginHomeRefresh(INITIAL_HOME_REFRESH_STATE);
    expect(cold).toEqual({
      initialLoading: true,
      backgroundRefreshing: false,
      hasCompleteSnapshot: false,
    });

    const revisiting = beginHomeRefresh(completeHomeRefresh());
    expect(revisiting).toEqual({
      initialLoading: false,
      backgroundRefreshing: true,
      hasCompleteSnapshot: true,
    });
  });

  it('preserves the last complete profile and Frequent Products while refreshing', () => {
    const visibleSnapshot = {
      profile: { category: 'food_ingredients' },
      frequentProducts: [{ key: 'mp_1' }],
    };
    const refreshing = beginHomeRefresh(completeHomeRefresh());

    expect(refreshing.initialLoading).toBe(false);
    expect(visibleSnapshot.profile).toEqual({ category: 'food_ingredients' });
    expect(visibleSnapshot.frequentProducts).toEqual([{ key: 'mp_1' }]);
  });

  it('preserves snapshot availability after a background failure', () => {
    const failed = failHomeRefresh(
      beginHomeRefresh(completeHomeRefresh())
    );
    expect(failed).toEqual({
      initialLoading: false,
      backgroundRefreshing: false,
      hasCompleteSnapshot: true,
    });
  });

  it('rejects an older request after a newer request becomes current', () => {
    expect(isLatestHomeRefresh(2, 2)).toBe(true);
    expect(isLatestHomeRefresh(1, 2)).toBe(false);
  });
});

describe('Home refresh production wiring', () => {
  const homeSource = fs.readFileSync(
    path.resolve(__dirname, '../app/(tabs)/index.tsx'),
    'utf8'
  );
  const insightsSource = fs.readFileSync(
    path.resolve(__dirname, '../components/ProgressiveHomeInsights.tsx'),
    'utf8'
  );

  it('publishes no intermediate Home experience before enrichment completes', () => {
    const receiptRead = homeSource.indexOf(
      "'initialReceiptRead'"
    );
    const enrichment = homeSource.indexOf(
      'const [evaluation, productContext] = await Promise.all'
    );
    const finalSnapshot = homeSource.indexOf(
      'setHomeExperience(finalCompleteExperience)'
    );

    expect(receiptRead).toBeGreaterThan(-1);
    expect(enrichment).toBeGreaterThan(receiptRead);
    expect(finalSnapshot).toBeGreaterThan(enrichment);
    expect(homeSource.slice(receiptRead, enrichment)).not.toContain(
      'setHomeExperience('
    );
    expect(homeSource).not.toContain(
      'setHomeExperience(buildHomeProgressiveExperience(analyticsReceipts, null))'
    );
  });

  it('keeps a complete snapshot on refresh failure and guards stale results', () => {
    expect(homeSource).toContain('if (hasCompleteSnapshotRef.current)');
    expect(homeSource).toContain("logger.warn('Home', 'background refresh failed'");
    expect(homeSource).toContain('isLatestHomeRefresh(');
    expect(homeSource).toContain('refreshGenerationRef.current');
  });

  it('uses initial loading only for the blocking Home spinner', () => {
    expect(homeSource).toContain('initialLoading={');
    expect(insightsSource).toContain('initialLoading && (');
    expect(insightsSource).not.toContain('backgroundRefreshing && (');
  });

  it('still revalidates Home and Pending Review on every focus', () => {
    expect(homeSource).toContain('useFocusEffect(');
    expect(homeSource).toContain('loadReceipts();');
    expect(homeSource).toContain('void refreshPendingReview();');
  });
});
