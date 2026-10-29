// Supabase Edge Function: turns a pasted listing link into a card. Called from the
// app's Add sheet (and the #/add?url= deep link) with the signed-in user's session.
//
// Request:  POST { url: "https://www.domain.com.au/12-smith-street-brunswick-vic-3056-2019123456" }
//           POST { dry_run: true, html } — parse a saved page only (no fetch, no database)
// Response: { property_id, merged, parse_status: "ok" | "partial" | "blocked", missing_fields, message, summary }
// A blocked or unreadable page still returns 200 with a card holding the link, so the
// app can open the edit sheet straight away; only a bad link or a server fault is an error.
import { createClient } from "npm:@supabase/supabase-js@2";
import { adminClient, CORS_HEADERS, extractUrl, importListing, json, missingFields, parseListing } from "../_shared/listing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { url?: string; html?: string; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send { url }" }, 400);
  }

  // Debugging aid: { dry_run: true, html } returns what the parser finds in a saved
  // page, without fetching anything or touching the database.
  if (body.dry_run && typeof body.html === "string") {
    const parsed = parseListing(body.html);
    return json({ parsed, missing_fields: missingFields(parsed) });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  if (userError || !userData.user) return json({ error: "Sign in again to add listings" }, 401);

  const admin = adminClient();
  const { data: member } = await admin.from("household_members").select("household_id").eq("user_id", userData.user.id).maybeSingle();
  if (!member) return json({ error: "Your account isn't part of a household" }, 403);

  const url = extractUrl(body.url ?? "");
  if (!url) return json({ error: "That doesn't look like a listing link" }, 400);

  try {
    return json(await importListing(admin, member.household_id, userData.user.id, url));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't save the listing";
    console.error("parse-listing failed", url, err);
    return json({ error: message }, message.startsWith("That doesn't") ? 400 : 500);
  }
});
