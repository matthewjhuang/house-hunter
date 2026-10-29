// Helpers every House Hunter Edge Function uses: CORS, JSON replies, the
// service-role client, and the pg_cron secret check.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

export function adminClient(): SupabaseClient {
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) {
    try {
      key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? "";
    } catch { /* fall through with an empty key; the first query reports it */ }
  }
  return createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
}

export async function isCronCall(req: Request, admin: SupabaseClient) {
  const secret = req.headers.get("x-cron-secret");
  if (!secret) return false;
  const { data } = await admin.rpc("verify_cron_secret", { candidate: secret });
  return data === true;
}
