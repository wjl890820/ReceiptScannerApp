// supabase/functions/ocr-receipt-v2/index.ts
// Strict OCR endpoint. Requires a public project API key and a Supabase user
// access token (including anonymous-auth users). No JWT-less fallback.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, handleOcrReceiptAfterAuth } from '../ocr-receipt/handler.ts';
import { handleOcrReceiptV2Request } from './auth.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  const result = await handleOcrReceiptV2Request(req, {
    env: {
      get(name: string) {
        return Deno.env.get(name);
      },
    },
    verifyUser: async (jwt) => {
      const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
      const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || req.headers.get('apikey') || '';
      if (!supabaseUrl || !supabaseAnonKey) return null;
      const authClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false },
      });
      const verified = await authClient.auth.getUser(jwt);
      const userId = verified.data?.user?.id;
      if (verified.error || !userId) return null;
      return { id: userId };
    },
    processAuthorized: (userId) =>
      handleOcrReceiptAfterAuth(
        req,
        {
          userId,
          deviceId: userId,
          actorType: 'user',
          actorId: userId,
        },
        { requestId: crypto.randomUUID(), startTime: Date.now() }
      ),
  });

  if (result.kind === 'options') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (result.kind === 'denied') {
    return jsonResponse(result.status, result.body);
  }
  return result.response;
});
