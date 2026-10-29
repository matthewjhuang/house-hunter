// Supabase Edge Function: travel times, nearest stops and geocoding.
//
// For every active property (anything not Rejected) and every place on the Places
// tab, works out a weekday trip arriving 8:30am by public transport and by car, and
// finds each property's nearest train station and tram stop with the walk to it.
// Properties and places without coordinates are geocoded first.
//
// All free, no keys:
//   - Photon (photon.komoot.io, OpenStreetMap data) for addresses, 1 request a second.
//     Nominatim would be the obvious choice but refuses requests from Supabase
//   - Transitous (transitous.org, PTV's timetables) for public transport, arrive-by
//   - OSRM (routing.openstreetmap.de) for car and walking times. It has no traffic,
//     so car times are multiplied by PEAK_FACTOR as a rush-hour allowance
//   - Overpass (OpenStreetMap) for stations and tram stops
//
// Called three ways (deployed with verify_jwt off; it checks callers itself):
//   - Database triggers, with x-cron-secret, when a property or place is added or its
//     address changes: { property_id } or { place_id }
//   - pg_cron nightly, with x-cron-secret and no body: fills in anything missing or
//     failed, and refreshes times older than STALE_DAYS
//   - The property sheet's Recalculate button, with the user's session:
//     { property_id, force: true }
//
// Times someone typed in themselves (travel_times.manual_s) are never overwritten.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminClient, CORS_HEADERS, isCronCall, json } from "../_shared/http.ts";

const UA = "HouseHunter/1.0 (https://matthewjhuang.github.io/house-hunter/)";
const TZ = "Australia/Melbourne";
const PEAK_FACTOR = 1.6;
const STALE_DAYS = 28;
// Leaves headroom under the Edge Function wall-clock limit.
const TIME_BUDGET_MS = 110_000;

interface Property {
  id: string;
  household_id: string;
  stage: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  geocode_status: string | null;
  nearest_stops: unknown[] | null;
}

interface Place {
  id: string;
  household_id: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  geocode_status: string | null;
}

interface TravelRow {
  property_id: string;
  place_id: string;
  mode: string;
  status: string;
  fingerprint: string | null;
  computed_at: string;
}

type Point = { lat: number; lng: number };

const PROPERTY_COLUMNS = "id, household_id, stage, address, suburb, state, postcode, latitude, longitude, geocode_status, nearest_stops";
const PLACE_COLUMNS = "id, household_id, address, latitude, longitude, geocode_status";

let deadline = 0;
const outOfTime = () => Date.now() > deadline;

async function getJson(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...init.headers }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} replied ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- geocoding

let lastGeocode = 0;

// ok: a building, house number or named place; approximate: only a street or suburb.
async function geocode(query: string): Promise<{ point: Point | null; status: "ok" | "approximate" | "not_found" }> {
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastGeocode = Date.now();
  // Biased towards Melbourne without ruling anywhere else out.
  const params = new URLSearchParams({ q: query, limit: "5", lat: "-37.81", lon: "144.96" });
  const d = await getJson(`https://photon.komoot.io/api/?${params}`);
  const hit = (d.features ?? []).find((f: { properties?: { countrycode?: string } }) => f.properties?.countrycode === "AU");
  if (!hit) return { point: null, status: "not_found" };
  const [lng, lat] = hit.geometry.coordinates;
  const type = hit.properties.type;
  const hasNumber = /^\s*[\d/]+[a-z]?\s/i.test(query);
  const exact = type === "house" || (type === "street" && !hasNumber);
  return { point: { lat, lng }, status: exact ? "ok" : "approximate" };
}

function propertyQuery(p: Property) {
  if (!p.address) return null;
  const hasSuburb = p.suburb && p.address.toLowerCase().includes(p.suburb.toLowerCase());
  const rest = hasSuburb ? "" : [p.suburb, p.state ?? "VIC", p.postcode].filter(Boolean).join(" ");
  return [p.address, rest, "Australia"].filter(Boolean).join(", ");
}

async function locateProperty(admin: SupabaseClient, p: Property, force = false): Promise<Point | null> {
  if (p.latitude != null && p.longitude != null && (p.geocode_status === null || p.geocode_status === "ok")) return { lat: p.latitude, lng: p.longitude };
  if (p.geocode_status && !force) return null;
  const query = propertyQuery(p);
  if (!query) return null;
  const { point, status } = await geocode(query);
  await admin.from("properties").update({ latitude: point?.lat ?? null, longitude: point?.lng ?? null, geocode_status: status }).eq("id", p.id);
  Object.assign(p, { latitude: point?.lat ?? null, longitude: point?.lng ?? null, geocode_status: status });
  // A suburb-level match would give misleading times, so those cards get none.
  return status === "ok" ? point : null;
}

async function locatePlace(admin: SupabaseClient, q: Place, force = false): Promise<Point | null> {
  if (q.latitude != null && q.longitude != null && q.geocode_status !== "not_found") return { lat: q.latitude, lng: q.longitude };
  if (q.geocode_status && !force) return null;
  const { point, status } = await geocode(`${q.address}, Australia`);
  await admin.from("places").update({ latitude: point?.lat ?? null, longitude: point?.lng ?? null, geocode_status: status }).eq("id", q.id);
  Object.assign(q, { latitude: point?.lat ?? null, longitude: point?.lng ?? null, geocode_status: status });
  // A place found only roughly still gets times; the Places tab flags it.
  return point;
}

// ---------------------------------------------------------------- routing

// Next Wednesday, 8:30am Melbourne time. Wednesday dodges Monday public holidays and
// Cup Day, and is never today, so there's always a full timetable.
function arrivalTime() {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  for (let d = 1; d <= 8; d++) {
    const at = new Date(Date.now() + d * 86_400_000);
    const parts = Object.fromEntries(day.formatToParts(at).map((x) => [x.type, x.value]));
    if (parts.weekday !== "Wed") continue;
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(at).find((x) => x.type === "timeZoneName")?.value.replace("GMT", "") || "+10:00";
    return `${parts.year}-${parts.month}-${parts.day}T08:30:00${offset}`;
  }
  throw new Error("no Wednesday found");
}

interface Leg {
  mode: string;
  routeShortName?: string;
}

function legLabel(leg: Leg) {
  const n = leg.routeShortName ?? "";
  if (leg.mode === "TRAM") return `Tram ${n}`.trim();
  if (leg.mode === "BUS" || leg.mode === "COACH") return `Bus ${n}`.trim();
  if (leg.mode === "FERRY") return "Ferry";
  return n ? `${n} line` : "Train";
}

async function transit(from: Point, to: Point, time: string) {
  const params = new URLSearchParams({ fromPlace: `${from.lat},${from.lng}`, toPlace: `${to.lat},${to.lng}`, time, arriveBy: "true" });
  const d = await getJson(`https://api.transitous.org/api/v5/plan?${params}`);
  const options = [...(d.itineraries ?? []), ...(d.direct ?? [])].filter((i: { duration?: number }) => i.duration && i.duration > 0);
  if (!options.length) return { status: "no_route", duration_s: null, summary: null };
  const best = options.reduce((a: { duration: number }, b: { duration: number }) => (b.duration < a.duration ? b : a));
  const rides = (best.legs ?? []).filter((l: Leg) => !["WALK", "BIKE", "CAR"].includes(l.mode));
  const summary = rides.length
    ? `${legLabel(rides[0])}${rides.length > 1 ? `, ${rides.length - 1} change${rides.length > 2 ? "s" : ""}` : ""}`
    : "Walk";
  return { status: "ok", duration_s: Math.round(best.duration), summary };
}

// OSRM table: durations (s) and distances (m) from each source to each destination.
async function osrmTable(profile: "car" | "foot", sources: Point[], destinations: Point[]) {
  const coords = [...sources, ...destinations].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const params = new URLSearchParams({
    sources: sources.map((_, i) => i).join(";"),
    destinations: destinations.map((_, i) => i + sources.length).join(";"),
    annotations: "duration,distance"
  });
  const d = await getJson(`https://routing.openstreetmap.de/routed-${profile}/table/v1/${profile === "car" ? "driving" : "foot"}/${coords}?${params}`);
  if (d.code !== "Ok") throw new Error(`OSRM ${d.code}`);
  return { durations: d.durations as (number | null)[][], distances: d.distances as (number | null)[][] };
}

// ---------------------------------------------------------------- nearest stops

function metres(a: Point, b: Point) {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

interface Stop extends Point {
  kind: "train" | "tram";
  name: string;
  routes: string | null;
}

async function nearestStops(at: Point) {
  const { lat, lng } = at;
  const query = `[out:json][timeout:20];(
    nwr(around:2500,${lat},${lng})[railway=station][!disused][!"railway:historic"];
    nwr(around:1200,${lat},${lng})[railway=tram_stop];
    nwr(around:1200,${lat},${lng})[public_transport=platform][tram=yes];
  );out center tags 80;`;
  const d = await getJson("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query })
  });
  const byKey = new Map<string, Stop>();
  for (const e of d.elements ?? []) {
    const t = e.tags ?? {};
    const point = { lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon };
    if (!t.name || point.lat == null) continue;
    const kind = t.railway === "station" && t.station !== "light_rail" ? "train" : "tram";
    // Tram stops are named like "Stop 36: Hope Street".
    const name = kind === "tram" ? t.name.replace(/^Stop\s+\w+\s*:\s*/i, "") : t.name.replace(/\s+(railway\s+)?station$/i, "");
    const key = `${kind}:${name.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || (!existing.routes && t.route_ref) || metres(at, point) < metres(at, existing)) {
      byKey.set(key, { kind, name, routes: t.route_ref ? String(t.route_ref).split(";").join(", ") : existing?.routes ?? null, ...point });
    }
  }
  const result = [];
  for (const kind of ["train", "tram"] as const) {
    const candidates = [...byKey.values()].filter((s) => s.kind === kind).sort((a, b) => metres(at, a) - metres(at, b)).slice(0, 3);
    if (!candidates.length) continue;
    const { durations, distances } = await osrmTable("foot", [at], candidates);
    let best = -1;
    candidates.forEach((_, i) => {
      if (durations[0][i] != null && (best < 0 || durations[0][i]! < durations[0][best]!)) best = i;
    });
    if (best < 0) continue;
    const s = candidates[best];
    result.push({ kind, name: s.name, routes: s.routes, walk_s: Math.round(durations[0][best]!), distance_m: Math.round(distances[0][best] ?? metres(at, s)) });
  }
  return result;
}

async function fillStops(admin: SupabaseClient, p: Property, at: Point) {
  if (p.nearest_stops) return;
  try {
    const stops = await nearestStops(at);
    await admin.from("properties").update({ nearest_stops: stops }).eq("id", p.id);
  } catch (err) {
    console.error("nearest stops failed", p.id, (err as Error).message);
  }
}

// ---------------------------------------------------------------- travel times

const fingerprint = (a: Point, b: Point) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;

function needsWork(row: TravelRow | undefined, fp: string, force: boolean) {
  if (!row || force) return true;
  if (row.fingerprint !== fp || row.status === "error") return true;
  return Date.now() - new Date(row.computed_at).getTime() > STALE_DAYS * 86_400_000;
}

// Computes car and public transport times for the given pairs (same household).
async function computePairs(admin: SupabaseClient, pairs: { p: Property; from: Point; q: Place; to: Point }[], force = false) {
  if (!pairs.length) return 0;
  const { data: existing } = await admin
    .from("travel_times")
    .select("property_id, place_id, mode, status, fingerprint, computed_at")
    .in("property_id", [...new Set(pairs.map((x) => x.p.id))])
    .in("place_id", [...new Set(pairs.map((x) => x.q.id))]);
  const rowFor = new Map((existing ?? []).map((r: TravelRow) => [`${r.property_id}|${r.place_id}|${r.mode}`, r]));
  const now = new Date().toISOString();
  const base = (x: (typeof pairs)[number], mode: string) => ({
    household_id: x.p.household_id, property_id: x.p.id, place_id: x.q.id, mode,
    fingerprint: fingerprint(x.from, x.to), computed_at: now
  });

  // Car: one OSRM table per batch of properties.
  const driveTodo = pairs.filter((x) => needsWork(rowFor.get(`${x.p.id}|${x.q.id}|drive`), fingerprint(x.from, x.to), force));
  const driveRows = [];
  for (let i = 0; i < driveTodo.length && !outOfTime(); i += 40) {
    const batch = driveTodo.slice(i, i + 40);
    const props = [...new Map(batch.map((x) => [x.p.id, x.from])).entries()];
    const places = [...new Map(batch.map((x) => [x.q.id, x.to])).entries()];
    try {
      const { durations, distances } = await osrmTable("car", props.map(([, pt]) => pt), places.map(([, pt]) => pt));
      for (const x of batch) {
        const si = props.findIndex(([id]) => id === x.p.id);
        const di = places.findIndex(([id]) => id === x.q.id);
        const s = durations[si][di];
        driveRows.push({
          ...base(x, "drive"),
          status: s == null ? "no_route" : "ok",
          duration_s: s == null ? null : Math.round(s * PEAK_FACTOR),
          distance_m: distances[si][di] == null ? null : Math.round(distances[si][di]!),
          summary: null
        });
      }
    } catch (err) {
      console.error("drive times failed", (err as Error).message);
      for (const x of batch) driveRows.push({ ...base(x, "drive"), status: "error", duration_s: null, distance_m: null, summary: null });
    }
  }
  if (driveRows.length) await admin.from("travel_times").upsert(driveRows, { onConflict: "property_id,place_id,mode" });

  // Public transport: one Transitous request per pair, a few at a time.
  const time = arrivalTime();
  const transitTodo = pairs.filter((x) => needsWork(rowFor.get(`${x.p.id}|${x.q.id}|transit`), fingerprint(x.from, x.to), force));
  let done = driveRows.length;
  for (let i = 0; i < transitTodo.length && !outOfTime(); i += 3) {
    const rows = await Promise.all(transitTodo.slice(i, i + 3).map(async (x) => {
      try {
        return { ...base(x, "transit"), ...(await transit(x.from, x.to, time)), distance_m: null };
      } catch (err) {
        console.error("transit failed", (err as Error).message);
        return { ...base(x, "transit"), status: "error", duration_s: null, summary: null, distance_m: null };
      }
    }));
    await admin.from("travel_times").upsert(rows, { onConflict: "property_id,place_id,mode" });
    done += rows.length;
  }
  return done;
}

async function placesWithPoints(admin: SupabaseClient, householdId: string) {
  const { data } = await admin.from("places").select(PLACE_COLUMNS).eq("household_id", householdId);
  const out: { q: Place; to: Point }[] = [];
  for (const q of (data ?? []) as Place[]) {
    if (outOfTime()) break;
    const to = await locatePlace(admin, q);
    if (to) out.push({ q, to });
  }
  return out;
}

async function runProperty(admin: SupabaseClient, id: string, force: boolean) {
  const { data: p } = await admin.from("properties").select(PROPERTY_COLUMNS).eq("id", id).maybeSingle();
  if (!p || p.stage === "rejected") return { skipped: "not an active property" };
  const from = await locateProperty(admin, p, force);
  if (!from) return { geocode: p.geocode_status ?? "no address" };
  if (force) p.nearest_stops = null;
  await fillStops(admin, p, from);
  const places = await placesWithPoints(admin, p.household_id);
  const computed = await computePairs(admin, places.map(({ q, to }) => ({ p, from, q, to })), force);
  return { computed };
}

async function runPlace(admin: SupabaseClient, id: string) {
  const { data: q } = await admin.from("places").select(PLACE_COLUMNS).eq("id", id).maybeSingle();
  if (!q) return { skipped: "no such place" };
  const to = await locatePlace(admin, q);
  if (!to) return { geocode: q.geocode_status };
  const { data: props } = await admin.from("properties").select(PROPERTY_COLUMNS).eq("household_id", q.household_id).neq("stage", "rejected");
  const pairs = [];
  for (const p of (props ?? []) as Property[]) {
    if (outOfTime()) break;
    const from = await locateProperty(admin, p);
    if (from) pairs.push({ p, from, q, to });
  }
  return { computed: await computePairs(admin, pairs) };
}

// Nightly: everything active, household by household.
async function backfill(admin: SupabaseClient) {
  const { data: props } = await admin.from("properties").select(PROPERTY_COLUMNS).neq("stage", "rejected");
  const byHousehold = new Map<string, Property[]>();
  for (const p of (props ?? []) as Property[]) byHousehold.set(p.household_id, [...(byHousehold.get(p.household_id) ?? []), p]);
  let computed = 0;
  for (const [householdId, list] of byHousehold) {
    const places = await placesWithPoints(admin, householdId);
    const pairs = [];
    for (const p of list) {
      if (outOfTime()) break;
      const from = await locateProperty(admin, p);
      if (!from) continue;
      await fillStops(admin, p, from);
      for (const { q, to } of places) pairs.push({ p, from, q, to });
    }
    computed += await computePairs(admin, pairs);
  }
  return { computed, finished: !outOfTime() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  deadline = Date.now() + TIME_BUDGET_MS;
  const admin = adminClient();
  const body = await req.json().catch(() => ({}));

  try {
    if (await isCronCall(req, admin)) {
      if (body.property_id) return json(await runProperty(admin, body.property_id, !!body.force));
      if (body.place_id) return json(await runPlace(admin, body.place_id));
      return json(await backfill(admin));
    }

    // Recalculate button: a signed-in member, for a property in their own household.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
    const { data } = await userClient.auth.getUser(token);
    if (!data.user || !body.property_id) return json({ error: "Not allowed" }, 401);
    const [{ data: member }, { data: p }] = await Promise.all([
      admin.from("household_members").select("household_id").eq("user_id", data.user.id).maybeSingle(),
      admin.from("properties").select("household_id").eq("id", body.property_id).maybeSingle()
    ]);
    if (!member || !p || member.household_id !== p.household_id) return json({ error: "Not allowed" }, 403);
    return json(await runProperty(admin, body.property_id, true));
  } catch (err) {
    console.error("travel-times failed", err);
    return json({ error: (err as Error).message }, 500);
  }
});
