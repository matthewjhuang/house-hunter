// Supabase Edge Function: inspection reminders by Web Push.
//
// Called two ways (deployed with verify_jwt off; it checks both itself):
//   - pg_cron every 5 minutes, with x-cron-secret. Sends each person a reminder for
//     every booked inspection that starts within their reminder lead time (Settings,
//     default 60 min), once — reminders_sent records who's been told.
//   - The app's "Send test notification" button in Settings, with the user's session:
//     sends that person one test push so you can check notifications work.
//
// Needs the Edge Function secrets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT
// (e.g. "mailto:you@example.com"). Without them it does nothing and says so.
// Subscriptions the push service reports as gone (404/410) are deleted.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";
import { adminClient, CORS_HEADERS, isCronCall, json } from "../_shared/http.ts";

interface Subscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const timeFormat = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "2-digit" });

async function push(admin: ReturnType<typeof adminClient>, sub: Subscription, payload: Record<string, unknown>) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60, urgency: "high" }
    );
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) await admin.from("push_subscriptions").delete().eq("id", sub.id);
    else console.error("push failed", status, (err as Error).message);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) return json({ skipped: "VAPID keys aren't set yet (see README → Push notifications)" });
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:househunter@example.com", publicKey, privateKey);

  const admin = adminClient();

  // Test push for the signed-in person.
  if (!(await isCronCall(req, admin))) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
    const { data } = await userClient.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
    if (!data.user) return json({ error: "Not allowed" }, 401);
    const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", data.user.id);
    if (!subs?.length) return json({ error: "This device isn't subscribed yet: turn on notifications first" }, 400);
    let sent = 0;
    for (const sub of subs) {
      if (await push(admin, sub, { title: "House Hunter", body: "Notifications are working. You'll hear from us before each booked inspection.", url: "#/settings", tag: "test" })) sent++;
    }
    return json({ sent });
  }

  // Scheduled run: booked inspections in the next 24 hours (the longest lead time).
  const now = Date.now();
  const { data: inspections, error } = await admin
    .from("inspection_times")
    .select("id, starts_at, household_id, property_id, properties(address, suburb, title, stage)")
    .eq("booked", true)
    .gt("starts_at", new Date(now).toISOString())
    .lt("starts_at", new Date(now + 24 * 60 * 60 * 1000).toISOString());
  if (error) return json({ error: error.message }, 500);
  if (!inspections?.length) return json({ sent: 0 });

  const householdIds = [...new Set(inspections.map((i) => i.household_id))];
  const [{ data: members }, { data: subs }, { data: alreadySent }] = await Promise.all([
    admin.from("household_members").select("household_id, user_id, reminder_lead_minutes").in("household_id", householdIds),
    admin.from("push_subscriptions").select("*").in("household_id", householdIds),
    admin.from("reminders_sent").select("inspection_id, user_id").in("inspection_id", inspections.map((i) => i.id))
  ]);
  const sentKeys = new Set((alreadySent ?? []).map((r) => `${r.inspection_id}:${r.user_id}`));

  let sent = 0;
  for (const inspection of inspections) {
    const property = inspection.properties as unknown as { address: string | null; suburb: string | null; title: string | null; stage: string } | null;
    if (!property || property.stage === "rejected") continue;
    const startsAt = new Date(inspection.starts_at).getTime();
    for (const member of (members ?? []).filter((m) => m.household_id === inspection.household_id)) {
      if (sentKeys.has(`${inspection.id}:${member.user_id}`)) continue;
      if (startsAt - member.reminder_lead_minutes * 60 * 1000 > now) continue;
      const minutes = Math.max(1, Math.round((startsAt - now) / 60000));
      const where = property.address ? `${property.address}${property.suburb ? ", " + property.suburb : ""}` : property.title ?? "a property";
      const payload = {
        title: `Inspection in ${minutes >= 60 ? `${Math.round(minutes / 60)} hr` : `${minutes} min`}`,
        body: `${where} at ${timeFormat.format(new Date(startsAt))}`,
        url: `#/p/${inspection.property_id}`,
        tag: `inspection-${inspection.id}`
      };
      for (const sub of (subs ?? []).filter((s) => s.user_id === member.user_id)) {
        if (await push(admin, sub, payload)) sent++;
      }
      // Recorded even with no devices, so turning notifications on later doesn't
      // fire a burst of stale reminders.
      await admin.from("reminders_sent").insert({ inspection_id: inspection.id, user_id: member.user_id });
    }
  }
  return json({ sent });
});
