// Supabase Edge Function: travel times, public transport lines, nearby shops and parks,
// and geocoding.
//
// For every active property (anything not Rejected) and every place on the Places
// tab, works out a weekday trip arriving 8:30am by public transport and by car, and
// finds the public transport lines within walking distance of each property (how often
// they run at 8am, and the last service each way at night), and its closest Coles,
// Woolworths, Aldi, Chemist Warehouse and park ("Nearby").
// Properties and places without coordinates are geocoded first.
//
// All free, no keys:
//   - Photon (photon.komoot.io, OpenStreetMap data) for addresses, 1 request a second.
//     Nominatim would be the obvious choice but refuses requests from Supabase
//   - Transitous (transitous.org, PTV's timetables) for public transport, arrive-by
//   - OSRM (routing.openstreetmap.de) for car and walking times. It has no traffic,
//     so car times are multiplied by PEAK_FACTOR as a rush-hour allowance
//   - Transitous again for the stops and timetables near each property
//   - nearby/nearby.json in the GitHub repo for stores and parks (OpenStreetMap,
//     rebuilt monthly by a GitHub Action), so they take no Supabase storage
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
// Short local drives, mostly outside peak hour, so a smaller allowance than commutes.
const LOCAL_FACTOR = 1.3;
const NEARBY_URL = "https://raw.githubusercontent.com/matthewjhuang/house-hunter/main/nearby/nearby.json";
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
  transit: { version?: string } | null;
  nearby: { version?: string } | null;
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

const PROPERTY_COLUMNS = "id, household_id, stage, address, suburb, state, postcode, latitude, longitude, geocode_status, transit, nearby";
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

// Next Wednesday in Melbourne: "2026-11-18" and its UTC offset ("+11:00"). Wednesday
// dodges Monday public holidays and Cup Day, and is never today, so there's always a
// full timetable.
function nextWednesday() {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  for (let d = 1; d <= 8; d++) {
    const at = new Date(Date.now() + d * 86_400_000);
    const parts = Object.fromEntries(day.formatToParts(at).map((x) => [x.type, x.value]));
    if (parts.weekday !== "Wed") continue;
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(at).find((x) => x.type === "timeZoneName")?.value.replace("GMT", "") || "+10:00";
    return { date: `${parts.year}-${parts.month}-${parts.day}`, offset };
  }
  throw new Error("no Wednesday found");
}

// Next Wednesday, 8:30am Melbourne time.
function arrivalTime() {
  const { date, offset } = nextWednesday();
  return `${date}T08:30:00${offset}`;
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

let lastOsrm = 0;

// OSRM table: durations (s) and distances (m) from each source to each destination.
// The FOSSGIS server answers bursts with 429, so calls are spaced out and retried once.
async function osrmTable(profile: "car" | "foot", sources: Point[], destinations: Point[], retry = true): Promise<{ durations: (number | null)[][]; distances: (number | null)[][] }> {
  const wait = lastOsrm + 1100 - Date.now();
  lastOsrm = Math.max(Date.now(), lastOsrm + 1100);
  if (wait > 0) await sleep(wait);
  const coords = [...sources, ...destinations].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const params = new URLSearchParams({
    sources: sources.map((_, i) => i).join(";"),
    destinations: destinations.map((_, i) => i + sources.length).join(";"),
    annotations: "duration,distance"
  });
  let d;
  try {
    d = await getJson(`https://routing.openstreetmap.de/routed-${profile}/table/v1/${profile === "car" ? "driving" : "foot"}/${coords}?${params}`);
  } catch (err) {
    if (!retry || !/ 429$/.test((err as Error).message)) throw err;
    await sleep(5000);
    return osrmTable(profile, sources, destinations, false);
  }
  if (d.code !== "Ok") throw new Error(`OSRM ${d.code}`);
  return { durations: d.durations as (number | null)[][], distances: d.distances as (number | null)[][] };
}

// ---------------------------------------------------------------- public transport

function metres(a: Point, b: Point) {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

type Mode = "train" | "tram" | "bus";
const TRAIN_MODES = ["SUBWAY", "RAIL", "SUBURBAN", "REGIONAL_RAIL", "METRO", "HIGHSPEED_RAIL", "LONG_DISTANCE"];
const modeOf = (m: string): Mode | null => (TRAIN_MODES.includes(m) ? "train" : m === "TRAM" ? "tram" : m === "BUS" ? "bus" : null);
// How far each is worth walking to: straight-line pre-filter, then real walking time.
const LIMITS: Record<Mode, { straight: number; walk_s: number }> = {
  train: { straight: 2000, walk_s: 25 * 60 },
  tram: { straight: 1200, walk_s: 15 * 60 },
  bus: { straight: 800, walk_s: 10 * 60 }
};
// Buses that come less often than this at 8am aren't worth listing.
const MIN_BUS_PEAK = 4;
const CBD = { lat: -37.8183, lng: 144.9671 }; // Flinders Street
const TRANSIT_REFRESH_DAYS = 28;

interface StopTime {
  mode: string;
  routeShortName?: string;
  headsign?: string;
  directionId?: string;
  tripTo?: { lat: number; lon: number };
  place: { departure?: string; scheduledDeparture?: string };
}

interface StopPoint extends Point {
  id: string;
  name: string;
  no: string | null;
  modes: Set<Mode>;
  d: number;
}

// One direction of one line, as seen from one stop.
interface Seen { s: StopPoint; peak: number; last: number; heads: Map<string, number>; routes: Map<string, number>; toCity: number; toOut: number }

async function stopTimes(stopId: string, time: string, n: number, earlier = false): Promise<StopTime[]> {
  const params = new URLSearchParams({ stopId, time, n: String(n), ...(earlier ? { direction: "EARLIER" } : {}) });
  const d = await getJson(`https://api.transitous.org/api/v1/stoptimes?${params}`);
  return d.stopTimes ?? [];
}

const departs = (x: StopTime) => x.place.departure ?? x.place.scheduledDeparture ?? "";
const bump = (m: Map<string, number>, k?: string) => k && m.set(k, (m.get(k) ?? 0) + 1);

// Every train station, tram route and frequent bus route within walking distance:
// how often it runs 7:30-8:30am next Wednesday and the last departure each way that
// night, each direction taken from its closest stop (the two sides of a road are
// separate stops). "city" marks the direction heading towards the CBD; the last
// service the other way is roughly when the last one gets you home.
async function transitLines(at: Point) {
  const reach = LIMITS.train.straight;
  const dLat = reach / 111_000;
  const dLng = dLat / Math.cos((at.lat * Math.PI) / 180);
  const params = new URLSearchParams({ min: `${at.lat - dLat},${at.lng - dLng}`, max: `${at.lat + dLat},${at.lng + dLng}` });
  const list = await getJson(`https://api.transitous.org/api/v1/map/stops?${params}`);

  // Each kerbside stop on its own; a station's platforms as one.
  const stops = new Map<string, StopPoint>();
  for (const s of list ?? []) {
    const modes = new Set(((s.modes ?? []) as string[]).map(modeOf).filter(Boolean) as Mode[]);
    const point = { lat: s.lat, lng: s.lon };
    const d = metres(at, point);
    const fits = [...modes].filter((m) => d <= LIMITS[m].straight);
    if (!fits.length || !s.name) continue;
    const id = modes.has("train") && s.parentId ? s.parentId : s.stopId;
    const no = s.name.match(/#\s*(\w+)\s*$/)?.[1] ?? null;
    const name = s.name.replace(/\s*#\s*\w+\s*$/, "").replace(/\s+(railway\s+)?station$/i, "").trim();
    const existing = stops.get(id);
    if (existing) { fits.forEach((m) => existing.modes.add(m)); if (d < existing.d) Object.assign(existing, point, { d }); continue; }
    stops.set(id, { id, name, no, modes: new Set(fits), d, ...point });
  }
  // Every station in range, then the closest kerbside stops (there can be hundreds).
  const byDistance = [...stops.values()].sort((a, b) => a.d - b.d);
  const nearest = [...byDistance.filter((s) => s.modes.has("train")), ...byDistance.filter((s) => !s.modes.has("train")).slice(0, 45)];

  const { date, offset } = nextWednesday();
  const peakFrom = new Date(`${date}T07:30:00${offset}`).getTime();
  const peakTo = peakFrom + 3_600_000;
  const nightFrom = new Date(`${date}T19:00:00${offset}`).getTime();
  const thursday = new Date(new Date(`${date}T12:00:00${offset}`).getTime() + 86_400_000).toISOString().slice(0, 10);

  // line key → direction key → what the closest stop serving that direction sees.
  const lines = new Map<string, { mode: Mode; route: string; dirs: Map<string, Seen> }>();
  for (let i = 0; i < nearest.length && !outOfTime(); i += 4) {
    await Promise.all(nearest.slice(i, i + 4).map(async (s) => {
      let peak: StopTime[], night: StopTime[];
      try {
        [peak, night] = await Promise.all([
          stopTimes(s.id, `${date}T07:30:00${offset}`, 150),
          stopTimes(s.id, `${thursday}T03:00:00${offset}`, 100, true)
        ]);
      } catch (err) {
        console.error("stop times failed", s.name, (err as Error).message);
        return;
      }
      const here = new Map<string, { mode: Mode; route: string; dirKey: string; seen: Seen }>();
      for (const [x, isPeak] of [...peak.map((x) => [x, true] as const), ...night.map((x) => [x, false] as const)]) {
        // Buses replacing trains during works still get you home, so they count as the train.
        const mode = s.modes.has("train") && /replacement/i.test(x.routeShortName ?? "") ? "train" : modeOf(x.mode);
        if (!mode || !s.modes.has(mode)) continue;
        const t = new Date(departs(x)).getTime();
        if (isPeak ? t < peakFrom || t >= peakTo : t < nightFrom) continue;
        // Trains: one entry per station, all its lines. Trams and buses: one per route.
        const lineKey = mode === "train" ? `train:${s.name}` : `${mode}:${x.routeShortName}`;
        const toCity = x.tripTo ? metres({ lat: x.tripTo.lat, lng: x.tripTo.lon }, CBD) < metres(s, CBD) - 500 : false;
        const dirKey = mode === "train" ? (toCity ? "in" : "out") : x.directionId ?? "0";
        const k = `${lineKey}|${dirKey}`;
        let h = here.get(k);
        if (!h) {
          h = { mode, route: x.routeShortName ?? "", dirKey, seen: { s, peak: 0, last: 0, heads: new Map(), routes: new Map(), toCity: 0, toOut: 0 } };
          here.set(k, h);
        }
        if (toCity) h.seen.toCity++; else h.seen.toOut++;
        bump(h.seen.heads, x.headsign);
        if (!/replacement/i.test(x.routeShortName ?? "")) bump(h.seen.routes, x.routeShortName);
        if (isPeak) h.seen.peak++;
        else h.seen.last = Math.max(h.seen.last, t);
      }
      for (const [k, h] of here) {
        const lineKey = k.slice(0, k.lastIndexOf("|"));
        const line = lines.get(lineKey) ?? { mode: h.mode, route: h.route, dirs: new Map() };
        lines.set(lineKey, line);
        const prev = line.dirs.get(h.dirKey);
        if (!prev || s.d < prev.s.d) line.dirs.set(h.dirKey, h.seen);
      }
    }));
  }

  const chosen = [...lines.values()]
    .map((l) => ({ ...l, dirs: [...l.dirs.values()] }))
    .filter((l) => l.mode !== "bus" || Math.max(...l.dirs.map((d) => d.peak)) >= MIN_BUS_PEAK)
    .map((l) => ({ ...l, stop: l.dirs.reduce((a, b) => (b.s.d < a.s.d ? b : a)).s }));
  if (!chosen.length) return [];
  const targets = [...new Set(chosen.map((l) => l.stop))];
  const foot = await osrmTable("foot", [at], targets);
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const merged = (dirs: Seen[]) => dirs.reduce((m, d) => { d.routes.forEach((n, k) => m.set(k, (m.get(k) ?? 0) + n)); return m; }, new Map<string, number>());
  const order: Mode[] = ["train", "tram", "bus"];
  return chosen
    .map((l) => {
      const i = targets.indexOf(l.stop);
      return {
        mode: l.mode,
        route: l.mode === "train" ? top(merged(l.dirs)).join(" · ") : l.route,
        stop: { name: l.stop.name, no: l.stop.no, lat: l.stop.lat, lon: l.stop.lng },
        walk_s: foot.durations[0][i] == null ? null : Math.round(foot.durations[0][i]!),
        distance_m: Math.round(foot.distances[0][i] ?? l.stop.d),
        dirs: l.dirs
          .map((d) => ({ to: top(d.heads)[0] ?? "", city: d.toCity > d.toOut, peak: d.peak, last: d.last ? new Date(d.last).toISOString() : null }))
          .sort((a, b) => Number(b.city) - Number(a.city) || b.peak - a.peak)
      };
    })
    .filter((l) => l.walk_s != null && l.walk_s <= LIMITS[l.mode].walk_s)
    .sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode) || a.walk_s! - b.walk_s!);
}

async function fillTransit(admin: SupabaseClient, p: Property, at: Point) {
  const age = p.transit?.version ? Date.now() - new Date(p.transit.version).getTime() : Infinity;
  if (age < TRANSIT_REFRESH_DAYS * 86_400_000) return;
  try {
    const lines = await transitLines(at);
    await admin.from("properties").update({ transit: { version: new Date().toISOString().slice(0, 10), lines } }).eq("id", p.id);
  } catch (err) {
    console.error("transit lines failed", p.id, (err as Error).message);
  }
}

// ---------------------------------------------------------------- nearby

interface NearbyData {
  updated: string;
  stores: Record<string, [number, number, string][]>;
  parks: [string, number, [number, number][]][];
}

const STORE_KINDS = ["coles", "woolworths", "aldi", "chemist_warehouse"];
let nearbyData: NearbyData | null = null;

async function nearbyFile() {
  nearbyData ??= await getJson(NEARBY_URL) as NearbyData;
  return nearbyData;
}

// The closest store of each brand and the closest park, by walking time. Candidates are
// the nearest few by straight line (for parks, by distance to their edge); OSRM then
// gives real walk and drive times to each.
async function nearby(at: Point) {
  const data = await nearbyFile();
  const candidates: { kind: string; name: string; to: Point; ha?: number }[] = [];
  for (const kind of STORE_KINDS) {
    (data.stores[kind] ?? [])
      .map(([lat, lng, name]) => ({ kind, name, to: { lat, lng }, d: metres(at, { lat, lng }) }))
      .filter((c) => c.d < 15_000)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .forEach((c) => candidates.push(c));
  }
  data.parks
    .map(([name, ha, outline]) => {
      const edge = outline.map(([lat, lng]) => ({ lat, lng })).reduce((best, pt) => (metres(at, pt) < metres(at, best) ? pt : best));
      return { kind: "park", name, ha, to: edge, d: metres(at, edge) };
    })
    .filter((c) => c.d < 5_000)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .forEach((c) => candidates.push(c));
  if (!candidates.length) return [];

  const dests = candidates.map((c) => c.to);
  const foot = await osrmTable("foot", [at], dests);
  const car = await osrmTable("car", [at], dests);
  const items = [];
  for (const kind of [...STORE_KINDS, "park"]) {
    let best = -1;
    candidates.forEach((c, i) => {
      if (c.kind !== kind || foot.durations[0][i] == null) return;
      if (best < 0 || foot.durations[0][i]! < foot.durations[0][best]!) best = i;
    });
    if (best < 0) continue;
    const c = candidates[best];
    items.push({
      kind, name: c.name, lat: c.to.lat, lon: c.to.lng,
      distance_m: Math.round(foot.distances[0][best] ?? metres(at, c.to)),
      walk_s: Math.round(foot.durations[0][best]!),
      drive_s: car.durations[0][best] == null ? null : Math.round(car.durations[0][best]! * LOCAL_FACTOR),
      ...(c.ha ? { ha: c.ha } : {})
    });
  }
  return items;
}

async function fillNearby(admin: SupabaseClient, p: Property, at: Point) {
  try {
    const { updated } = await nearbyFile();
    if (p.nearby?.version === updated) return;
    const items = await nearby(at);
    await admin.from("properties").update({ nearby: { version: updated, items } }).eq("id", p.id);
  } catch (err) {
    console.error("nearby failed", p.id, (err as Error).message);
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
  if (force) Object.assign(p, { transit: null, nearby: null });
  await fillTransit(admin, p, from);
  await fillNearby(admin, p, from);
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
      await fillTransit(admin, p, from);
      await fillNearby(admin, p, from);
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
