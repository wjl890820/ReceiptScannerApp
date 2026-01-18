// lib/feedbackService.ts
// Lazy import Constants to avoid initialization crashes
let Constants: typeof import('expo-constants') | null = null;

async function getConstants() {
  if (!Constants) {
    try {
      Constants = await import('expo-constants');
    } catch (e) {
      console.warn('[FeedbackService] Failed to import Constants:', e);
      return null;
    }
  }
  return Constants;
}

async function getSupabaseUrl(): Promise<string> {
  try {
    const ConstantsModule = await getConstants();
    if (!ConstantsModule) return '';
    
    // Safely access Constants with fallback
    const expoConfig = ConstantsModule?.expoConfig;
    const manifest = ConstantsModule?.manifest;
    
    const fromExpoConfig =
      (expoConfig?.extra as any)?.SUPABASE_URL ??
      (expoConfig?.extra as any)?.supabaseUrl;

    const fromManifest =
      (manifest as any)?.extra?.SUPABASE_URL ??
      (manifest as any)?.extra?.supabaseUrl;

    const url = (fromExpoConfig ?? fromManifest ?? '').trim();
    return url;
  } catch (e) {
    console.error('[FeedbackService] Failed to get Supabase URL from Constants:', e);
    return '';
  }
}

async function getSupabaseAnonKey(): Promise<string> {
  try {
    const ConstantsModule = await getConstants();
    if (!ConstantsModule) return '';
    
    // Safely access Constants with fallback
    const expoConfig = ConstantsModule?.expoConfig;
    const manifest = ConstantsModule?.manifest;
    
    const fromExpoConfig =
      (expoConfig?.extra as any)?.SUPABASE_ANON_KEY ??
      (expoConfig?.extra as any)?.supabaseAnonKey;

    const fromManifest =
      (manifest as any)?.extra?.SUPABASE_ANON_KEY ??
      (manifest as any)?.extra?.supabaseAnonKey;

    const key = (fromExpoConfig ?? fromManifest ?? '').trim();
    return key;
  } catch (e) {
    console.error('[FeedbackService] Failed to get Supabase Anon Key from Constants:', e);
    return '';
  }
}

export type FeedbackPayload = {
  feedback: string;
  email?: string;
  appVersion: string;
  platform: string;
  language: string;
};

export async function submitFeedback(payload: FeedbackPayload): Promise<void> {
  const supabaseUrl = await getSupabaseUrl();

  if (!supabaseUrl) {
    throw new Error('Supabase URL 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/send-feedback`;

  const supabaseAnonKey = await getSupabaseAnonKey();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (supabaseAnonKey) {
    headers['Authorization'] = `Bearer ${supabaseAnonKey}`;
  }

  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `反馈提交失败（HTTP ${response.status}）：${errorText || response.statusText}`
    );
  }

  const result = await response.json().catch(() => ({}));
  
  if (result.error) {
    throw new Error(result.error || '反馈提交失败');
  }
}
