// Supabase Edge Function: the daily re-check, called by pg_cron (x-cron-secret).
// Re-fetches every card that's still in play (not Rejected or Lease signed) and
// records what changed: rent, "under application" / "leased", or the listing being
// taken down. Each change is a property_changes row and sets has_unseen_changes,
// which shows the badge on the card until someone opens it.
//
// Sites that block us are skipped quietly (last_checked_at still moves on) rather
// than counted as removed: only a 404/410, or a redirect away from the listing, means gone.
// Domain links are checked through Domain's API when it's set up, and cards whose first
// import was blocked get another go at filling their details in.
import {
  adminClient, domainConfigured, fetchDomainListing, fetchListing, importListing, isCronCall, json, parseListing, type Source
} from "../_shared/listing.ts";

const MAX_PER_RUN = 40;
const DELAY_MS = 1500;

const STATUS_LABEL: Record<string, string> = {
  active: "Available",
  under_application: "Under application",
  leased: "Leased",
  removed: "Listing removed"
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  const admin = adminClient();
  if (!(await isCronCall(req, admin))) return json({ error: "Not allowed" }, 401);

  const { data: properties, error } = await admin
    .from("properties")
    .select("id, household_id, created_by, rent_pw, listing_status, parse_status, sources")
    .not("stage", "in", "(rejected,lease_signed)")
    .neq("listing_status", "removed")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);
  if (error) return json({ error: error.message }, 500);

  const report = { checked: 0, changed: 0, blocked: 0, filled: 0 };
  for (const property of properties ?? []) {
    const sources = (property.sources as Source[]) ?? [];
    if (!sources.length) continue;
    report.checked++;

    // Fill in a card the first import couldn't read (merges into this same card).
    if (property.parse_status === "blocked" || property.parse_status === "partial") {
      try {
        const result = await importListing(admin, property.household_id, property.created_by, sources[0].url);
        if (result.parse_status !== "blocked") report.filled++;
      } catch (err) {
        console.error("refill failed", property.id, err);
      }
    }

    let gone = 0;
    let newRent: number | null = null;
    let newStatus: string | null = null;
    const inspections: { starts_at: string; ends_at: string | null }[] = [];

    for (const source of sources) {
      if (source.site === "domain.com.au" && source.listing_id && domainConfigured()) {
        const api = await fetchDomainListing(source.listing_id);
        if (api.status === "gone" || api.removed) { gone++; continue; }
        if (api.status !== "ok" || !api.parsed) { report.blocked++; continue; }
        if (api.parsed.rent_pw && newRent === null) newRent = api.parsed.rent_pw;
        if (api.parsed.listing_status && api.parsed.listing_status !== "active") newStatus = api.parsed.listing_status;
        inspections.push(...api.parsed.inspections);
        continue;
      }
      const res = await fetchListing(source.url);
      if (res.status === "gone") { gone++; continue; }
      if (res.status !== "ok") { report.blocked++; continue; }
      // REA and Domain send a removed listing to a search page.
      if (source.listing_id && !res.finalUrl.includes(source.listing_id)) { gone++; continue; }
      const parsed = parseListing(res.html);
      if (parsed.rent_pw && newRent === null) newRent = parsed.rent_pw;
      if (parsed.listing_status && parsed.listing_status !== "active") newStatus = parsed.listing_status;
      inspections.push(...parsed.inspections);
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
    if (gone === sources.length) newStatus = "removed";

    const changes: { kind: string; old_value: string | null; new_value: string | null }[] = [];
    const update: Record<string, unknown> = { last_checked_at: new Date().toISOString() };
    if (newRent !== null && property.rent_pw !== null && newRent !== property.rent_pw) {
      changes.push({ kind: "price", old_value: `$${property.rent_pw}/wk`, new_value: `$${newRent}/wk` });
      update.rent_pw = newRent;
    }
    if (newStatus && newStatus !== property.listing_status) {
      changes.push({
        kind: newStatus === "removed" ? "removed" : "status",
        old_value: STATUS_LABEL[property.listing_status] ?? property.listing_status,
        new_value: STATUS_LABEL[newStatus] ?? newStatus
      });
      update.listing_status = newStatus;
    }
    if (changes.length) {
      update.has_unseen_changes = true;
      report.changed++;
      await admin.from("property_changes").insert(changes.map((c) => ({ ...c, property_id: property.id, household_id: property.household_id })));
    }
    await admin.from("properties").update(update).eq("id", property.id);

    if (inspections.length) {
      await admin.from("inspection_times").upsert(
        inspections.map((i) => ({ ...i, property_id: property.id, household_id: property.household_id, origin: "parsed" })),
        { onConflict: "property_id,starts_at", ignoreDuplicates: true }
      );
    }
  }

  console.log("recheck-listings", report);
  return json(report);
});
