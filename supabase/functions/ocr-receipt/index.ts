// supabase/functions/ocr-receipt/index.ts
// Legacy OCR endpoint. Historical clients may call this without a user JWT.
// Authentication stays optional: a failed or missing user JWT falls through to
// x-device-id anonymous mode. New clients must use ocr-receipt-v2 instead.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveVerifiedUserId } from './verifyAuthUser.ts';
import {
  corsHeaders,
  handleOcrReceiptAfterAuth,
  isJwt,
  parseAuthHeader,
  type OcrReceiptActor,
} from './handler.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase configuration missing');
    }

    const authHeader = req.headers.get('authorization') ?? '';
    const bearer = parseAuthHeader(authHeader);
    const apiKey = req.headers.get('apikey') ?? '';
    const deviceIdHeader = req.headers.get('x-device-id') ?? '';

    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || apiKey;

    // Determine authentication mode (OPTIONAL — Build 34 clients need no user JWT).
    // user_id for ocr_runs MUST come from authoritative Auth verification only.
    let userId: string | null = null;
    let deviceId = '';
    let actorType: 'anon' | 'user' = 'anon';
    let actorId = '';

    if (bearer && isJwt(bearer)) {
      try {
        const authClient = createClient(supabaseUrl, supabaseAnonKey, {
          auth: {
            persistSession: false,
          },
        });

        userId = await resolveVerifiedUserId({
          bearerToken: bearer,
          verifyWithSupabaseAuth: async (jwt) => {
            const result = await authClient.auth.getUser(jwt);
            return {
              data: { user: result.data?.user ? { id: result.data.user.id } : null },
              error: result.error,
            };
          },
        });

        if (userId) {
          deviceId = userId;
          actorType = 'user';
          actorId = userId;
        }
      } catch (e) {
        // If JWT validation fails, don't throw - just proceed as anonymous
        console.log(`[${requestId}] JWT validation failed, proceeding as anonymous:`, e);
        userId = null;
      }
    }

    if (!userId) {
      if (!deviceIdHeader) {
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'OCR_DEVICE_ID_REQUIRED',
              message: 'x-device-id header is required for anonymous requests',
            },
          }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
      deviceId = deviceIdHeader;
      actorType = 'anon';
      actorId = deviceIdHeader;
    }

    const actor: OcrReceiptActor = { userId, deviceId, actorType, actorId };
    return await handleOcrReceiptAfterAuth(req, actor, { requestId, startTime });
  } catch (error: any) {
    const message = String(error?.message || 'Internal server error').slice(0, 200);
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message,
          requestId,
          model: Deno.env.get('OCR_GEMINI_MODEL') || 'gemini-3.5-flash-lite',
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
