/**
 * Batch AI feature flag tests.
 */

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

describe('isBatchAiClassificationEnabled', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ENABLE_BATCH_AI_CLASSIFICATION;
    delete process.env.EXPO_PUBLIC_ENABLE_BATCH_AI_CLASSIFICATION;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('默认 true（保持生产兼容）', async () => {
    const { isBatchAiClassificationEnabled } = await import('./env');
    expect(isBatchAiClassificationEnabled()).toBe(true);
  });

  it('ENABLE_BATCH_AI_CLASSIFICATION=false 时关闭', async () => {
    process.env.ENABLE_BATCH_AI_CLASSIFICATION = 'false';
    const { isBatchAiClassificationEnabled } = await import('./env');
    expect(isBatchAiClassificationEnabled()).toBe(false);
  });

  it('ENABLE_BATCH_AI_CLASSIFICATION=0 时关闭', async () => {
    process.env.ENABLE_BATCH_AI_CLASSIFICATION = '0';
    const { isBatchAiClassificationEnabled } = await import('./env');
    expect(isBatchAiClassificationEnabled()).toBe(false);
  });
});
