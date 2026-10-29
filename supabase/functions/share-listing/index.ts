// Supabase Edge Function: the endpoint the iOS Shortcut calls from the Share Sheet.
// iOS opens Shortcut links in Safari rather than the installed app, so instead of
// deep-linking, the Shortcut posts the listing here and the card appears on both
// boards through Realtime.
//
// Auth is a personal token from Settings → iOS Shortcut (only its SHA-256 hash is
// stored), sent as "Authorization: Bearer <token>". Deployed with verify_jwt off.
//
// Request:  POST { url } — or { text } with the shared text, the first link in it is used.
//           Optional { html }: the page as the phone fetched it, parsed if our own
//           request to the site is refused.
// Response: text/plain, one line for the Shortcut to show, e.g. "Added 12 Smith St, Brunswick"
import { adminClient, CORS_HEADERS, extractUrl, importListing, sha256Hex } from "../_shared/listing.ts";

function text(message: string, status = 200) {
  return new Response(message, { status, headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return text("POST only", 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token.length < 20) return text("House Hunter: missing token. Copy it again from Settings → iOS Shortcut.", 401);

  const admin = adminClient();
  const { data: owner } = await admin.from("share_tokens").select("user_id, household_id").eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!owner) return text("House Hunter: this token was revoked. Make a new one in Settings → iOS Shortcut.", 401);

  let raw = "";
  let html: string | null = null;
  const contentType = req.headers.get("Content-Type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      raw = String(body.url ?? body.text ?? "");
      html = typeof body.html === "string" ? body.html : null;
    } else if (contentType.includes("form")) {
      const form = await req.formData();
      raw = String(form.get("url") ?? form.get("text") ?? "");
      html = typeof form.get("html") === "string" ? String(form.get("html")) : null;
    } else {
      raw = await req.text();
    }
  } catch {
    return text("House Hunter: couldn't read what was shared.", 400);
  }

  // Shared from Safari, the "text" can be the page title rather than its address, so
  // fall back to the link the page gives for itself.
  const pageUrl = html?.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1]
    ?? html?.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? "";
  const url = extractUrl(raw) ?? extractUrl(pageUrl);
  if (!url) return text("House Hunter: no link found in what was shared.", 400);

  // What the phone managed to read, so a blocked import can be told apart from a bad page.
  console.log("share-listing", url, "html", html ? `${html.length} chars, title: ${html.match(/<title[^>]*>([^<]{0,80})/i)?.[1] ?? "none"}` : "none");
  if (html) {
    const has = (re: RegExp) => (re.test(html!) ? "y" : "n");
    console.log("share-listing html markers", `ld:${has(/application\/ld\+json/)} next:${has(/__NEXT_DATA__/)} script:${has(/<script/i)} escaped:${has(/&lt;script/i)}`, JSON.stringify(html.slice(0, 200)));
  }

  try {
    const result = await importListing(admin, owner.household_id, owner.user_id, url, html);
    console.log("share-listing result", result.parse_status, result.message ?? "", "missing:", result.missing_fields.join(","));
    return text(result.summary);
  } catch (err) {
    console.error("share-listing failed", url, err);
    return text(`House Hunter: ${err instanceof Error ? err.message : "couldn't save the listing"}.`, 500);
  }
});
