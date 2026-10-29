// Single Supabase client instance — every other file imports this one.
// The anon key is safe to expose in client code; Row Level Security is what actually
// keeps the household's data private.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = "https://esifddbuuyztqcqqebgx.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVzaWZkZGJ1dXl6dHFjcXFlYmd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMjk5NTEsImV4cCI6MjEwODgwNTk1MX0.0FYzH4G1vmCMh5fZGTDMOMwSKUfuZUU9gjHLW7_rros";

// Public half of the Web Push (VAPID) key pair. The private half is the
// VAPID_PRIVATE_KEY Edge Function secret.
export const VAPID_PUBLIC_KEY = "BOaaM5cwkzKfu88YzywQfCWByMPhkYCDDm0fcG1sHiWtE4vsV6jKV9MStrz_xCF-Hn05UfL3GQ-k-MMoWDwK83A";

export const isConfigured = SUPABASE_URL !== "YOUR_SUPABASE_URL" && SUPABASE_ANON_KEY !== "YOUR_SUPABASE_ANON_KEY";

// Falls back to a syntactically-valid placeholder so createClient doesn't throw
// before the real credentials are filled in — app.js checks isConfigured and
// shows a setup message instead of trying to actually use this client.
export const supabase = createClient(
  isConfigured ? SUPABASE_URL : "https://placeholder.supabase.co",
  isConfigured ? SUPABASE_ANON_KEY : "placeholder-anon-key",
  { auth: { persistSession: true, autoRefreshToken: true } }
);
