// lib/feedbackService.ts
import Constants from 'expo-constants';
import { getSupabaseUrl, getSupabaseAnonKey } from './env';

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
