// Supabase Edge Function: serve privacy policy HTML from Storage (bucket=legal, path=privacy-policy.html)
// Returns UTF-8 HTML with correct Content-Type to fix iOS garbled text when opening the URL.

// deno-lint-ignore no-import-prefix -- Supabase Edge Functions require URL imports for Deno runtime
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BUCKET = 'legal';
const PATH = 'privacy-policy.html';

const FALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Privacy</title></head><body><p>页面暂不可用</p></body></html>`;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=600',
  'Access-Control-Allow-Origin': '*',
};

Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(FALLBACK_HTML, { status: 200, headers: HEADERS });
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase.storage.from(BUCKET).download(PATH);

    if (error || !data) {
      return new Response(FALLBACK_HTML, { status: 200, headers: HEADERS });
    }

    const html = await data.text();
    return new Response(html, { status: 200, headers: HEADERS });
  } catch (_e) {
    return new Response(FALLBACK_HTML, { status: 200, headers: HEADERS });
  }
});
