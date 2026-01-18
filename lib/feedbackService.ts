// lib/feedbackService.ts
import Constants from 'expo-constants';

function getSupabaseUrl(): string {
  const fromExpoConfig =
    (Constants.expoConfig?.extra as any)?.SUPABASE_URL ??
    (Constants.expoConfig?.extra as any)?.supabaseUrl;

  const fromManifest =
    (Constants.manifest as any)?.extra?.SUPABASE_URL ??
    (Constants.manifest as any)?.extra?.supabaseUrl;

  const url = (fromExpoConfig ?? fromManifest ?? '').trim();
  return url;
}

function getSupabaseAnonKey(): string {
  const fromExpoConfig =
    (Constants.expoConfig?.extra as any)?.SUPABASE_ANON_KEY ??
    (Constants.expoConfig?.extra as any)?.supabaseAnonKey;

  const fromManifest =
    (Constants.manifest as any)?.extra?.SUPABASE_ANON_KEY ??
    (Constants.manifest as any)?.extra?.supabaseAnonKey;

  const key = (fromExpoConfig ?? fromManifest ?? '').trim();
  return key;
}

export type FeedbackPayload = {
  feedback: string;
  email?: string;
  appVersion: string;
  platform: string;
  language: string;
};

export async function submitFeedback(payload: FeedbackPayload): Promise<void> {
  const supabaseUrl = getSupabaseUrl();

  if (!supabaseUrl) {
    throw new Error('Supabase URL 未配置（请检查 .env / app.config.js / expo start -c）');
  }

  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/send-feedback`;

  const supabaseAnonKey = getSupabaseAnonKey();

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
