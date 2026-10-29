// Shared by parse-listing, share-listing and recheck-listings: fetch a listing page,
// pull the fields out of it, and merge the result into the household's cards.
//
// Parsing order (first value found wins, later sources only fill gaps):
//   1. JSON-LD blocks
//   2. Embedded app data — Next.js __NEXT_DATA__ (Domain) and REA's ArgonautExchange
//   3. Open Graph / meta tags, then plain-text patterns in the page
// REA and Domain often refuse requests from servers. That isn't an error here: the
// caller still gets a card holding the URL, with every field listed as missing.
// Domain links skip all of this and use Domain's official API when its credentials
// are set (see "Domain API" below).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export { adminClient, CORS_HEADERS, isCronCall, json } from "./http.ts";

// ---------------------------------------------------------------------------
// Types

export interface Inspection {
  starts_at: string;
  ends_at: string | null;
}

export interface Parsed {
  title: string | null;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  rent_pw: number | null;
  bond: number | null;
  beds: number | null;
  baths: number | null;
  cars: number | null;
  property_type: string | null;
  available_date: string | null;
  description: string | null;
  agent_name: string | null;
  agency: string | null;
  agent_phone: string | null;
  agent_email: string | null;
  photo_urls: string[];
  inspections: Inspection[];
  listing_status: "active" | "under_application" | "leased" | null;
}

export interface FetchResult {
  status: "ok" | "blocked" | "gone" | "error";
  httpStatus: number;
  html: string;
  finalUrl: string;
  message?: string;
}

export interface Source {
  site: string;
  url: string;
  listing_id: string | null;
}

// Fields shown as "missing" on a card. Photos and inspections are useful but not
// required, so they're listed only when nothing at all came through.
export const KEY_FIELDS = ["address", "rent_pw", "beds", "baths", "cars", "available_date", "bond", "agent_name", "photo_urls"] as const;
// A card is only flagged "Needs details" when one of these is missing — the rest
// (bond especially, which Domain's API doesn't give) can stay blank.
const CORE_FIELDS = ["address", "rent_pw", "beds"] as const;

function emptyParsed(): Parsed {
  return {
    title: null, address: null, suburb: null, state: null, postcode: null, latitude: null, longitude: null,
    rent_pw: null, bond: null, beds: null, baths: null, cars: null, property_type: null, available_date: null,
    description: null, agent_name: null, agency: null, agent_phone: null, agent_email: null,
    photo_urls: [], inspections: [], listing_status: null
  };
}

// ---------------------------------------------------------------------------
// URLs

export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[).,]+$/, "") : null;
}

// Refuses anything that isn't a public web address, so the function can't be
// pointed at internal services.
export function validateUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /\.(local|internal|localhost)$/.test(host)) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  url.hash = "";
  return url;
}

export function sourceFor(url: URL): Source {
  const host = url.hostname.replace(/^www\./, "");
  let site = host;
  let listingId: string | null = null;
  if (host.endsWith("realestate.com.au")) {
    site = "realestate.com.au";
    listingId = url.pathname.match(/-(\d{6,})\/?$/)?.[1] ?? null;
  } else if (host.endsWith("domain.com.au")) {
    site = "domain.com.au";
    listingId = url.pathname.match(/-(\d{6,})\/?$/)?.[1] ?? null;
  }
  // Drop tracking parameters so the same listing shared twice is the same URL.
  const clean = new URL(url.toString());
  for (const key of [...clean.searchParams.keys()]) {
    if (/^(utm_|sourcePage|sourceElement|ref|campaign|cid|fbclid|gclid)/i.test(key)) clean.searchParams.delete(key);
  }
  return { site, url: clean.toString(), listing_id: listingId };
}

// ---------------------------------------------------------------------------
// Fetching

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9"
};

const BLOCK_MARKERS = [
  /kpsdk/i, /Pardon Our Interruption/i, /captcha/i, /Access Denied/i, /Request unsuccessful/i,
  /cf-chl-/i, /Just a moment\.\.\./i, /are you a robot/i
];

export async function fetchListing(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: controller.signal });
    const html = (await res.text()).slice(0, 3_000_000);
    const base = { httpStatus: res.status, html, finalUrl: res.url || url };
    if (res.status === 404 || res.status === 410) return { ...base, status: "gone" };
    if (res.status === 403 || res.status === 429 || res.status === 503 || res.status === 401) {
      return { ...base, status: "blocked", message: `The site refused the request (${res.status})` };
    }
    if (!res.ok) return { ...base, status: "error", message: `The site returned an error (${res.status})` };
    if (html.length < 2000 && BLOCK_MARKERS.some((m) => m.test(html))) {
      return { ...base, status: "blocked", message: "The site showed a bot check instead of the listing" };
    }
    if (BLOCK_MARKERS.slice(0, 2).some((m) => m.test(html)) && !/application\/ld\+json|__NEXT_DATA__|og:title/.test(html)) {
      return { ...base, status: "blocked", message: "The site showed a bot check instead of the listing" };
    }
    return { ...base, status: "ok" };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { status: "error", httpStatus: 0, html: "", finalUrl: url, message: aborted ? "The site took too long to respond" : "Couldn't reach the site" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Small parsing helpers

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string") {
    const m = v.replace(/,/g, "").match(/\d+(\.\d+)?/);
    if (m) return Math.round(Number(m[0]));
  }
  if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) return toInt((v as Record<string, unknown>).value);
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = decodeEntities(v).trim();
    return t || null;
  }
  if (typeof v === "number") return String(v);
  return null;
}

// "$650 per week", "$650pw", "$2,800 pcm", "$650 - $680" → dollars per week.
export function parseRent(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.replace(/,/g, "");
  const m = t.match(/\$\s*(\d{2,5})(?:\.\d+)?/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (/(per\s*month|pcm|p\/m|monthly|\/\s*month)/i.test(t)) return Math.round((amount * 12) / 52);
  if (amount > 5000) return null; // almost certainly a sale price or a typo
  return amount;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

// Returns YYYY-MM-DD. "Available now" becomes today (Melbourne).
export function parseDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (/\bnow\b|immediately/i.test(t)) return melbourneToday();
  const dmy = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[A-Za-z]*,?\s+(\d{4})/);
  if (dmy && MONTHS[dmy[2].toLowerCase()]) {
    return `${dmy[3]}-${String(MONTHS[dmy[2].toLowerCase()]).padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  const slash = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  return null;
}

function melbourneToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date());
}

// Listing sites give inspection times in Melbourne local time, often without an
// offset. Returns a proper ISO instant.
export function melbourneInstant(value: string): string | null {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = value.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Australia/Melbourne", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(new Date(asUtc)).map((p) => [p.type, p.value])
  );
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const offset = shown - asUtc;
  return new Date(asUtc - offset).toISOString();
}

const STATES = "VIC|NSW|QLD|SA|WA|TAS|ACT|NT";

// "12/34 Smith Street, Brunswick VIC 3056" → parts.
export function splitAddress(full: string) {
  const text = full.replace(/\s+/g, " ").trim();
  const m = text.match(new RegExp(`^(.*?),\\s*([A-Za-z' .-]+?)(?:,)?\\s+(${STATES})\\b,?\\s*(\\d{4})?`, "i"));
  if (m) return { street: m[1].trim(), suburb: titleCase(m[2].trim()), state: m[3].toUpperCase(), postcode: m[4] ?? null };
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { street: parts[0], suburb: titleCase(parts[1]), state: null, postcode: null };
  return { street: text, suburb: null, state: null, postcode: null };
}

// "12 Smith St, Brunswick VIC 3056" with suburb "Brunswick" → "12 Smith St".
function stripSuburb(street: string, suburb: string) {
  const escaped = suburb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return street.replace(new RegExp(`,?\\s*${escaped}.*$`, "i"), "").trim();
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const STREET_TYPES: Record<string, string> = {
  street: "st", road: "rd", avenue: "ave", av: "ave", drive: "dr", court: "ct", place: "pl", crescent: "cres",
  parade: "pde", boulevard: "blvd", lane: "ln", terrace: "tce", highway: "hwy", grove: "gr", close: "cl",
  square: "sq", circuit: "cct", way: "way", walk: "wk", esplanade: "esp", parkway: "pkwy", rise: "rise"
};

// The same property from REA and Domain should produce the same key:
// "Unit 3, 12 Smith Street, Brunswick VIC 3056" and "3/12 Smith St, Brunswick"
// both become "3/12 smith st brunswick".
export function addressKey(street: string | null, suburb: string | null): string | null {
  if (!street || !suburb) return null;
  let s = street.toLowerCase();
  s = s.replace(/\b(unit|apartment|apt|flat|suite|townhouse|villa)\s*/g, "u ");
  s = s.replace(/\bu\s+([0-9a-z]+)\s*,?\s*(\d)/g, "$1/$2");
  s = s.replace(/[.,#]/g, " ").replace(/\s*\/\s*/g, "/");
  s = s.split(/\s+/).filter(Boolean).map((w) => STREET_TYPES[w] ?? w).join(" ");
  const sub = suburb.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  return `${s} ${sub}`.trim();
}

function setIfEmpty<K extends keyof Parsed>(p: Parsed, key: K, value: Parsed[K] | null | undefined) {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(p[key])) {
    if ((p[key] as unknown[]).length === 0 && Array.isArray(value) && value.length) p[key] = value;
    return;
  }
  if (p[key] === null) p[key] = value as Parsed[K];
}

function applyAddress(p: Parsed, full: string | null) {
  if (!full) return;
  const a = splitAddress(full);
  setIfEmpty(p, "address", a.street);
  setIfEmpty(p, "suburb", a.suburb);
  setIfEmpty(p, "state", a.state);
  setIfEmpty(p, "postcode", a.postcode);
}

function isImageUrl(s: string) {
  return /^https:\/\/[^\s"']+\.(jpe?g|png|webp)(\?[^\s"']*)?$/i.test(s) ||
    /^https:\/\/(bucket-api\.domain\.com\.au|rimh2\.domainstatic\.com\.au|i\d\.au\.reastatic\.net)\//i.test(s);
}

// ---------------------------------------------------------------------------
// 1. JSON-LD

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>)["@graph"])) {
          out.push(...((item as Record<string, unknown>)["@graph"] as unknown[]));
        } else {
          out.push(item);
        }
      }
    } catch { /* one malformed block shouldn't stop the others */ }
  }
  return out;
}

function fromJsonLd(p: Parsed, html: string) {
  for (const node of jsonLdBlocks(html)) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const type = ([] as unknown[]).concat(n["@type"] ?? []).map(String).join(" ");

    if (/Event/.test(type) && typeof n.startDate === "string") {
      const start = melbourneInstant(n.startDate);
      if (start) p.inspections.push({ starts_at: start, ends_at: typeof n.endDate === "string" ? melbourneInstant(n.endDate) : null });
      continue;
    }

    const address = n.address as Record<string, unknown> | string | undefined;
    if (address && typeof address === "object") {
      const street = str(address.streetAddress);
      const suburb = str(address.addressLocality);
      if (street && suburb) {
        setIfEmpty(p, "address", stripSuburb(street, suburb));
        setIfEmpty(p, "suburb", titleCase(suburb));
        setIfEmpty(p, "state", str(address.addressRegion)?.toUpperCase() ?? null);
        setIfEmpty(p, "postcode", str(address.postalCode));
      }
    } else if (typeof address === "string") {
      applyAddress(p, address);
    }

    const geo = n.geo as Record<string, unknown> | undefined;
    if (geo) {
      setIfEmpty(p, "latitude", Number(geo.latitude) || null);
      setIfEmpty(p, "longitude", Number(geo.longitude) || null);
    }

    setIfEmpty(p, "beds", toInt(n.numberOfBedrooms ?? n.numberOfRooms));
    setIfEmpty(p, "baths", toInt(n.numberOfBathroomsTotal ?? n.numberOfFullBathrooms));
    if (/Residence|House|Apartment|Townhouse|Accommodation|Place|Product|RealEstateListing/.test(type)) {
      setIfEmpty(p, "title", str(n.name));
      setIfEmpty(p, "description", str(n.description)?.slice(0, 2000) ?? null);
      if (/House|Apartment|Townhouse/.test(type)) setIfEmpty(p, "property_type", type.match(/House|Apartment|Townhouse/)![0]);
    }

    const images = ([] as unknown[]).concat(n.image ?? n.photo ?? []);
    const urls = images
      .map((i) => (typeof i === "string" ? i : str((i as Record<string, unknown>)?.url ?? (i as Record<string, unknown>)?.contentUrl)))
      .filter((u): u is string => !!u && u.startsWith("https://"));
    if (urls.length) setIfEmpty(p, "photo_urls", urls);

    const offers = ([] as unknown[]).concat(n.offers ?? [])[0] as Record<string, unknown> | undefined;
    if (offers) {
      const price = str(offers.price) ?? str(offers.description);
      const rent = price && /\$/.test(price) ? parseRent(price) : toInt(offers.price);
      if (rent && rent < 5000) setIfEmpty(p, "rent_pw", rent);
      setIfEmpty(p, "available_date", parseDate(str(offers.availabilityStarts)));
      const seller = offers.offeredBy as Record<string, unknown> | undefined;
      if (seller) {
        setIfEmpty(p, "agent_name", str(seller.name));
        setIfEmpty(p, "agent_phone", str(seller.telephone));
        setIfEmpty(p, "agent_email", str(seller.email));
      }
    }

    // Only an actual agency: sites also describe themselves as an Organization.
    if (/RealEstateAgent/.test(type)) {
      setIfEmpty(p, "agency", str(n.name));
    }
    if (/^Person$/.test(type)) {
      setIfEmpty(p, "agent_name", str(n.name));
      setIfEmpty(p, "agent_phone", str(n.telephone));
      setIfEmpty(p, "agent_email", str(n.email));
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Embedded app data (__NEXT_DATA__, REA ArgonautExchange, other inline JSON)

function embeddedJson(html: string): unknown[] {
  const out: unknown[] = [];
  const next = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (next) {
    try { out.push(JSON.parse(next[1])); } catch { /* ignore */ }
  }
  // REA: window.ArgonautExchange = {...}; values are themselves JSON strings.
  const argo = html.match(/window\.ArgonautExchange\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (argo) {
    try { out.push(JSON.parse(argo[1])); } catch { /* ignore */ }
  }
  // Other sites: any inline <script type="application/json">.
  for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[0].includes("__NEXT_DATA__")) continue;
    try { out.push(JSON.parse(m[1])); } catch { /* ignore */ }
  }
  return out;
}

// Sections that describe other properties or the suburb, not this listing.
const SKIP_KEYS = /^(listingsmap|otherlistings|otherlistingsids|similar|recommend|nearby|suburbinsights|neighbourhood|locationprofile|schools|soldlistings|projectlistings|user)/;

// A primitive, or the display/value inside a wrapper object.
function valueOf(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v as string | number | boolean;
  const o = v as Record<string, unknown>;
  for (const k of ["display", "value", "displayValue", "text"]) {
    const inner = o[k];
    if (inner !== null && inner !== undefined && typeof inner !== "object") return inner as string | number | boolean;
  }
  return null;
}

// Domain hides agent emails as base64.
function decodeEmail(v: unknown): string | null {
  const s = str(valueOf(v));
  if (!s) return null;
  if (s.includes("@")) return s;
  try {
    const decoded = atob(s);
    return decoded.includes("@") ? decoded : null;
  } catch {
    return null;
  }
}

interface Walked {
  values: Map<string, unknown[]>;
  objects: Record<string, unknown>[];
  images: string[];
}

// Flattens nested data into "every value seen for each key name", parsing JSON
// strings found along the way (REA nests JSON inside JSON).
function walk(root: unknown): Walked {
  const values = new Map<string, unknown[]>();
  const objects: Record<string, unknown>[] = [];
  const images = new Set<string>();
  let budget = 200000;
  const visit = (v: unknown, depth: number) => {
    if (budget-- <= 0 || depth > 40) return;
    if (typeof v === "string") {
      if (v.length > 1 && (v[0] === "{" || v[0] === "[") && v.length < 2_000_000) {
        try { visit(JSON.parse(v), depth + 1); return; } catch { /* plain string */ }
      }
      const filled = v.includes("{size}") ? v.replace("{size}", "1280x960") : v;
      if (isImageUrl(filled)) images.add(filled);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      objects.push(o);
      const record = (key: string, val: unknown) => {
        if (!values.has(key)) values.set(key, []);
        values.get(key)!.push(val);
      };
      // { key: "bond", value: 1825 } pairs (Domain's stats list).
      if (typeof o.key === "string" && (o.value !== undefined || o.iso8601Value !== undefined)) {
        record(o.key.toLowerCase(), o.iso8601Value ?? o.value);
      }
      for (const [k, val] of Object.entries(o)) {
        const key = k.toLowerCase();
        if (SKIP_KEYS.test(key)) continue;
        if (val === null || typeof val !== "object") record(key, val);
        else if (!Array.isArray(val)) {
          // { display: "$650 per week" } / { value: 3 } wrappers (REA).
          const inner = valueOf(val);
          if (inner !== null) record(key, inner);
        }
        visit(val, depth + 1);
      }
    }
  };
  visit(root, 0);
  return { values, objects, images: [...images] };
}

function first(w: Walked, keys: string[], pick: (v: unknown) => unknown = (v) => v) {
  for (const k of keys) {
    for (const v of w.values.get(k.toLowerCase()) ?? []) {
      const r = pick(v);
      if (r !== null && r !== undefined && r !== "") return r;
    }
  }
  return null;
}

// Domain's Next.js page data, read by its exact shape. Runs before the generic walk,
// which then only fills gaps.
function fromDomain(p: Parsed, root: unknown) {
  // deno-lint-ignore no-explicit-any
  const cp = (root as any)?.props?.pageProps?.componentProps;
  if (!cp || typeof cp !== "object" || !cp.listingSummary) return;
  const ls = cp.listingSummary;
  applyAddress(p, str(ls.address) ?? str(cp.address) ?? str(cp.inspection?.displayAddress));
  setIfEmpty(p, "postcode", str(cp.postcode));
  setIfEmpty(p, "state", str(cp.stateAbbreviation)?.toUpperCase() ?? null);
  setIfEmpty(p, "beds", toInt(ls.beds));
  setIfEmpty(p, "baths", toInt(ls.baths));
  setIfEmpty(p, "cars", toInt(ls.parking));
  setIfEmpty(p, "rent_pw", parseRent(str(ls.title)));
  setIfEmpty(p, "property_type", str(ls.propertyType) ?? str(cp.propertyType));
  for (const stat of Array.isArray(ls.stats) ? ls.stats : []) {
    if (stat?.key === "availableFrom") setIfEmpty(p, "available_date", parseDate(str(stat.iso8601Value) ?? str(stat.value)));
    if (stat?.key === "bond") setIfEmpty(p, "bond", toInt(stat.value));
  }
  const status = String(ls.status ?? "").toLowerCase();
  if (/leased/.test(status)) p.listing_status = "leased";
  else if (/application|deposit/.test(status)) p.listing_status = "under_application";
  setIfEmpty(p, "title", str(cp.headline));
  const description = Array.isArray(cp.description) ? cp.description.join("\n") : str(cp.description);
  setIfEmpty(p, "description", description ? stripTags(description).slice(0, 2000) : null);
  setIfEmpty(p, "latitude", typeof cp.map?.latitude === "number" ? cp.map.latitude : null);
  setIfEmpty(p, "longitude", typeof cp.map?.longitude === "number" ? cp.map.longitude : null);
  const agent = Array.isArray(cp.agents) ? cp.agents[0] : null;
  if (agent) {
    setIfEmpty(p, "agent_name", str(agent.name));
    setIfEmpty(p, "agent_phone", str(agent.mobile) ?? str(agent.phone));
    setIfEmpty(p, "agent_email", decodeEmail(agent.email));
  }
  setIfEmpty(p, "agency", str(cp.agencyName));
  const slides = Array.isArray(cp.gallery?.slides) ? cp.gallery.slides : [];
  setIfEmpty(p, "photo_urls", slides.map((sl: { images?: { original?: { url?: string } } }) => sl?.images?.original?.url).filter((u: unknown): u is string => typeof u === "string" && u.startsWith("https://")).slice(0, 30));
  for (const t of Array.isArray(cp.inspection?.inspectionTimes) ? cp.inspection.inspectionTimes : []) {
    const start = typeof t?.openingDateTime === "string" ? melbourneInstant(t.openingDateTime) : null;
    if (start) p.inspections.push({ starts_at: start, ends_at: typeof t.closingDateTime === "string" ? melbourneInstant(t.closingDateTime) : null });
  }
}

function fromEmbedded(p: Parsed, html: string) {
  for (const root of embeddedJson(html)) {
    fromDomain(p, root);
    const w = walk(root);

    const full = first(w, ["displayAddress", "fullAddress", "addressDisplay", "formattedAddress"], str) as string | null;
    if (full && /\d/.test(full)) applyAddress(p, full);
    const street = first(w, ["streetAddress", "street", "displayableAddress"], str) as string | null;
    const suburb = first(w, ["suburb", "suburbName", "addressLocality", "locality"], str) as string | null;
    if (street && /\d/.test(street) && suburb) {
      setIfEmpty(p, "address", stripSuburb(street, suburb));
      setIfEmpty(p, "suburb", titleCase(suburb));
    }
    setIfEmpty(p, "state", first(w, ["state", "stateAbbreviation", "addressRegion"], (v) => (str(v) && new RegExp(`^(${STATES})$`, "i").test(str(v)!) ? str(v)!.toUpperCase() : null)) as string | null);
    setIfEmpty(p, "postcode", first(w, ["postcode", "postCode", "postalCode"], (v) => (str(v)?.match(/^\d{4}$/) ? str(v) : null)) as string | null);
    setIfEmpty(p, "latitude", first(w, ["latitude", "lat"], (v) => (typeof v === "number" && v < -9 && v > -45 ? v : null)) as number | null);
    setIfEmpty(p, "longitude", first(w, ["longitude", "lng", "lon"], (v) => (typeof v === "number" && v > 110 && v < 155 ? v : null)) as number | null);

    const small = (v: unknown) => { const n = toInt(v); return n !== null && n >= 0 && n < 20 ? n : null; };
    setIfEmpty(p, "beds", first(w, ["beds", "bedrooms", "numBedrooms", "bedroomCount"], small) as number | null);
    setIfEmpty(p, "baths", first(w, ["baths", "bathrooms", "numBathrooms", "bathroomCount"], small) as number | null);
    setIfEmpty(p, "cars", first(w, ["parking", "carspaces", "carSpaces", "parkingSpaces", "numParkingSpaces", "garageSpaces"], small) as number | null);
    setIfEmpty(p, "property_type", first(w, ["propertyType", "propertyTypeFormatted"], str) as string | null);

    const priceText = first(w, ["displayPrice", "priceText", "price", "priceDisplay", "title"], (v) => (typeof v === "string" && /\$/.test(v) ? v : null)) as string | null;
    setIfEmpty(p, "rent_pw", parseRent(priceText));
    setIfEmpty(p, "bond", first(w, ["bond", "bondAmount"], (v) => { const n = toInt(v); return n && n > 100 ? n : null; }) as number | null);
    setIfEmpty(p, "available_date", parseDate(first(w, ["dateAvailable", "availableDate", "availableFrom", "dateAvailableFrom", "availableFromDate"], str) as string | null));
    setIfEmpty(p, "description", (first(w, ["description", "descriptionText"], (v) => (typeof v === "string" && v.length > 60 ? stripTags(v) : null)) as string | null)?.slice(0, 2000) ?? null);
    setIfEmpty(p, "title", first(w, ["headline", "listingTitle"], str) as string | null);

    const status = first(w, ["status", "listingStatus", "statusLabel", "saleMode"], (v) => (typeof v === "string" ? v.toLowerCase() : null)) as string | null;
    if (status) {
      if (/\bleased\b|^let$/.test(status)) p.listing_status = "leased";
      else if (/under.?application|deposit/.test(status)) p.listing_status = "under_application";
    }

    // Agents: objects with a name and a phone.
    for (const o of w.objects) {
      const name = str(valueOf(o.name ?? o.fullName ?? o.displayName));
      const phone = str(valueOf(o.mobile ?? o.mobileNumber ?? o.mobilePhone ?? o.phone ?? o.phoneNumber ?? o.telephone));
      if (name && phone && /\d{6,}/.test(phone.replace(/\D/g, "")) && name.split(" ").length <= 5) {
        setIfEmpty(p, "agent_name", name);
        setIfEmpty(p, "agent_phone", phone);
        setIfEmpty(p, "agent_email", decodeEmail(o.email ?? o.emailAddress));
        const agency = o.agency as Record<string, unknown> | undefined;
        setIfEmpty(p, "agency", str(o.agencyName) ?? str(agency?.name));
        break;
      }
    }
    setIfEmpty(p, "agency", first(w, ["agencyName", "brandName"], str) as string | null);

    // Inspections: objects with an opening/start time.
    for (const o of w.objects) {
      const start = str(valueOf(o.openingDateTime ?? o.startTime ?? o.startsAt ?? o.start ?? o.openTime));
      if (!start || !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start)) continue;
      const end = str(valueOf(o.closingDateTime ?? o.endTime ?? o.endsAt ?? o.end ?? o.closeTime));
      const startIso = melbourneInstant(start);
      if (startIso) p.inspections.push({ starts_at: startIso, ends_at: end ? melbourneInstant(end) : null });
    }

    if (w.images.length) {
      const photos = w.images
        .filter((u) => !/logo|avatar|agent|profile|contact_|icon|brand|floorplan|static\/|map/i.test(u))
        .filter((u) => !/\/(?:fit-in\/)?[1-3]?\d{2}x[1-3]?\d{2}\//.test(u)) // thumbnails
        .slice(0, 30);
      setIfEmpty(p, "photo_urls", photos);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Open Graph / meta tags, then plain text

function meta(html: string, name: string) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i");
  const m = html.match(re1) ?? html.match(re2);
  return m ? decodeEntities(m[1]).trim() || null : null;
}

function fromMeta(p: Parsed, html: string) {
  const ogTitle = meta(html, "og:title") ?? html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null;
  const ogDesc = meta(html, "og:description") ?? meta(html, "description");
  const ogImage = meta(html, "og:image");

  if (ogTitle) {
    setIfEmpty(p, "title", decodeEntities(ogTitle));
    // Titles like "12 Smith Street, Brunswick VIC 3056 | Domain" or
    // "3 bedroom apartment for Rent at 12 Smith St, Brunswick VIC 3056".
    const cleaned = decodeEntities(ogTitle).replace(/\s*[|–-]\s*(Domain|realestate\.com\.au|REA).*$/i, "").replace(/^.*?\bat\s+/i, "");
    if (/\d/.test(cleaned) && new RegExp(`\\b(${STATES})\\b`, "i").test(cleaned)) applyAddress(p, cleaned);
  }
  if (ogImage && ogImage.startsWith("https://")) setIfEmpty(p, "photo_urls", [ogImage]);

  const text = [ogTitle, ogDesc].filter(Boolean).join(" ");
  setIfEmpty(p, "beds", toInt(text.match(/(\d+)\s*(?:bed|bedroom|br)\b/i)?.[1]));
  setIfEmpty(p, "baths", toInt(text.match(/(\d+)\s*(?:bath|bathroom)/i)?.[1]));
  setIfEmpty(p, "cars", toInt(text.match(/(\d+)\s*(?:car|parking|garage)/i)?.[1]));
  setIfEmpty(p, "rent_pw", parseRent(text.match(/\$[\d,]+[^.|]*?(?:week|pw|p\/w|month|pcm)?/i)?.[0]));
  setIfEmpty(p, "description", ogDesc);

  // Plain-text fallbacks over the visible page.
  const body = stripTags(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")).slice(0, 200000);
  setIfEmpty(p, "rent_pw", parseRent(body.match(/\$[\d,]{3,6}(?:\.\d\d)?\s*(?:per\s*week|pw|p\/w|\/\s*week|weekly)/i)?.[0]));
  setIfEmpty(p, "bond", toInt(body.match(/bond\s*:?\s*\$\s*([\d,]{3,6})/i)?.[1]));
  setIfEmpty(p, "available_date", parseDate(body.match(/available\s*(?:from|date)?\s*:?\s*(now|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]));
  if (!p.listing_status) {
    if (/\bunder application\b|\bdeposit taken\b/i.test(body)) p.listing_status = "under_application";
    else if (/\bthis property (?:has been|is) leased\b|\bleased\b\s*(?:on|by)\b/i.test(body)) p.listing_status = "leased";
  }
}

// ---------------------------------------------------------------------------

export function parseListing(html: string): Parsed {
  const p = emptyParsed();
  fromJsonLd(p, html);
  fromEmbedded(p, html);
  fromMeta(p, html);
  return tidy(p);
}

function tidy(p: Parsed): Parsed {
  // Upcoming inspections only, de-duplicated, soonest first.
  const now = Date.now() - 60 * 60 * 1000;
  const seen = new Set<string>();
  p.inspections = p.inspections
    .filter((i) => new Date(i.starts_at).getTime() > now)
    .filter((i) => (seen.has(i.starts_at) ? false : (seen.add(i.starts_at), true)))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 20);
  p.photo_urls = [...new Set(p.photo_urls)].slice(0, 30);
  if (p.agent_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.agent_email)) p.agent_email = null;
  return p;
}

function coreMissing(p: Partial<Parsed>) {
  return CORE_FIELDS.some((k) => p[k] === null || p[k] === undefined || p[k] === "");
}

export function missingFields(p: Partial<Parsed>): string[] {
  return KEY_FIELDS.filter((k) => {
    const v = p[k];
    return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
  });
}

// ---------------------------------------------------------------------------
// Domain API (developer.domain.com.au, free tier). Domain refuses page requests from
// servers, so Domain links are read from the API when either is set as an Edge
// Function secret:
//   DOMAIN_API_KEY                           sent as X-API-Key, or
//   DOMAIN_CLIENT_ID + DOMAIN_CLIENT_SECRET  OAuth client credentials
// The API has everything except bond. Agent and agency names cost one extra call
// each and are skipped quietly if the plan doesn't include them.

const DOMAIN_API = "https://api.domain.com.au/v1";
let domainToken: { value: string; expires: number } | null = null;

export function domainConfigured() {
  return !!(Deno.env.get("DOMAIN_API_KEY") || (Deno.env.get("DOMAIN_CLIENT_ID") && Deno.env.get("DOMAIN_CLIENT_SECRET")));
}

async function domainHeaders(): Promise<Record<string, string> | null> {
  const key = Deno.env.get("DOMAIN_API_KEY");
  if (key) return { "X-API-Key": key, Accept: "application/json" };
  const id = Deno.env.get("DOMAIN_CLIENT_ID");
  const secret = Deno.env.get("DOMAIN_CLIENT_SECRET");
  if (!id || !secret) return null;
  if (!domainToken || domainToken.expires < Date.now() + 60_000) {
    // Ask for agency details too; fall back to listings only if the plan doesn't have them.
    for (const scope of ["api_listings_read api_agencies_read", "api_listings_read"]) {
      const res = await fetch("https://auth.domain.com.au/v1/connect/token", {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope })
      });
      if (res.ok) {
        const t = await res.json();
        domainToken = { value: t.access_token, expires: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
        break;
      }
      console.error("Domain token request failed", res.status, (await res.text()).slice(0, 200));
    }
    if (!domainToken) return null;
  }
  return { Authorization: `Bearer ${domainToken.value}`, Accept: "application/json" };
}

async function domainGet(path: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(`${DOMAIN_API}${path}`, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const PROPERTY_TYPES: Record<string, string> = {
  apartmentUnitFlat: "Apartment", house: "House", townhouse: "Townhouse", studio: "Studio", duplex: "Duplex",
  semiDetached: "Semi-detached", terrace: "Terrace", villa: "Villa", penthouse: "Penthouse", newApartments: "Apartment"
};

export interface DomainResult {
  status: "ok" | "gone" | "error";
  parsed?: Parsed;
  removed?: boolean;
  message?: string;
}

export async function fetchDomainListing(listingId: string): Promise<DomainResult> {
  const headers = await domainHeaders();
  if (!headers) return { status: "error", message: "Domain API credentials were refused" };
  let res: Response;
  try {
    res = await domainGet(`/listings/${encodeURIComponent(listingId)}`, headers);
  } catch {
    return { status: "error", message: "Domain's API didn't respond" };
  }
  if (res.status === 404 || res.status === 410) return { status: "gone" };
  if (!res.ok) {
    console.error("Domain listing request failed", res.status, (await res.text()).slice(0, 200));
    return { status: "error", message: `Domain's API returned an error (${res.status})` };
  }
  // deno-lint-ignore no-explicit-any
  const l: any = await res.json();
  const p = emptyParsed();
  const a = l.addressParts ?? {};
  applyAddress(p, str(a.displayAddress));
  if (!p.address && a.street && a.streetNumber) {
    setIfEmpty(p, "address", `${a.unitNumber ? `${a.unitNumber}/` : ""}${a.streetNumber} ${titleCase(String(a.street))}`);
  }
  setIfEmpty(p, "suburb", a.suburb ? titleCase(String(a.suburb)) : null);
  setIfEmpty(p, "state", str(a.stateAbbreviation)?.toUpperCase() ?? null);
  setIfEmpty(p, "postcode", str(a.postcode));
  setIfEmpty(p, "latitude", typeof l.geoLocation?.latitude === "number" ? l.geoLocation.latitude : null);
  setIfEmpty(p, "longitude", typeof l.geoLocation?.longitude === "number" ? l.geoLocation.longitude : null);
  const price = l.priceDetails ?? {};
  setIfEmpty(p, "rent_pw", parseRent(str(price.displayPrice)) ?? (typeof price.price === "number" && price.price < 5000 ? Math.round(price.price) : null));
  setIfEmpty(p, "beds", toInt(l.bedrooms));
  setIfEmpty(p, "baths", toInt(l.bathrooms));
  setIfEmpty(p, "cars", toInt(l.carspaces));
  const type = Array.isArray(l.propertyTypes) ? String(l.propertyTypes[0] ?? "") : "";
  setIfEmpty(p, "property_type", PROPERTY_TYPES[type] ?? (type ? titleCase(type.replace(/([a-z])([A-Z])/g, "$1 $2")) : null));
  setIfEmpty(p, "available_date", parseDate(str(l.dateAvailable)));
  setIfEmpty(p, "bond", toInt(l.bond ?? l.rentalDetails?.bond));
  setIfEmpty(p, "title", str(l.headline));
  setIfEmpty(p, "description", l.description ? stripTags(String(l.description)).slice(0, 2000) : null);
  setIfEmpty(p, "photo_urls", (Array.isArray(l.media) ? l.media : [])
    .filter((m: { category?: string; type?: string; url?: string }) => m?.category === "image" && m?.type !== "floorplan" && typeof m.url === "string")
    .map((m: { url: string }) => m.url)
    .slice(0, 30));
  for (const i of Array.isArray(l.inspectionDetails?.inspections) ? l.inspectionDetails.inspections : []) {
    const start = str(i?.openingDateTime ?? i?.startTime ?? i?.start);
    const end = str(i?.closingDateTime ?? i?.endTime ?? i?.end);
    const startIso = start ? melbourneInstant(start) : null;
    if (startIso) p.inspections.push({ starts_at: startIso, ends_at: end ? melbourneInstant(end) : null });
  }
  const status = String(l.status ?? "").toLowerCase();
  if (/leased/.test(status)) p.listing_status = "leased";
  else if (/underoffer|deposit|application/.test(status)) p.listing_status = "under_application";
  const removed = /archived|withdrawn|offmarket|sold|expired/.test(status);

  // Agent and agency: best effort, never blocks the import.
  const contactId = l.advertiserIdentifiers?.contactIds?.[0];
  const agencyId = l.advertiserIdentifiers?.advertiserId;
  const [agentRes, agencyRes] = await Promise.allSettled([
    contactId ? domainGet(`/agents/${contactId}`, headers).then((r) => (r.ok ? r.json() : null)) : Promise.resolve(null),
    agencyId ? domainGet(`/agencies/${agencyId}`, headers).then((r) => (r.ok ? r.json() : null)) : Promise.resolve(null)
  ]);
  const agent = agentRes.status === "fulfilled" ? agentRes.value : null;
  if (agent) {
    const name = str(agent.name) ?? [str(agent.firstName), str(agent.lastName)].filter(Boolean).join(" ");
    setIfEmpty(p, "agent_name", name || null);
    setIfEmpty(p, "agent_phone", str(agent.mobile) ?? str(agent.phone) ?? str(agent.mobilePhone));
    setIfEmpty(p, "agent_email", decodeEmail(agent.email ?? agent.emailAddress));
  }
  const agency = agencyRes.status === "fulfilled" ? agencyRes.value : null;
  if (agency) setIfEmpty(p, "agency", str(agency.name) ?? str(agency.profile?.agencyName));

  return { status: "ok", parsed: tidy(p), removed };
}

// ---------------------------------------------------------------------------
// Merge into the household's cards

export interface ImportResult {
  property_id: string;
  merged: boolean;
  parse_status: "ok" | "partial" | "blocked";
  missing_fields: string[];
  message: string | null;
  summary: string;
}

const COPY_FIELDS = [
  "title", "address", "suburb", "state", "postcode", "latitude", "longitude", "rent_pw", "bond", "beds", "baths",
  "cars", "property_type", "available_date", "description", "agent_name", "agency", "agent_phone", "agent_email"
] as const;

export async function importListing(
  admin: SupabaseClient,
  householdId: string,
  userId: string,
  rawUrl: string,
  // Page HTML fetched on the phone by the iOS Shortcut. Used only when our own
  // request is refused, since the sites block servers far more often than phones.
  providedHtml?: string | null
): Promise<ImportResult> {
  const url = validateUrl(rawUrl);
  if (!url) throw new Error("That doesn't look like a listing link");
  const source = sourceFor(url);
  let fromApi: Parsed | null = null;
  if (source.site === "domain.com.au" && source.listing_id && domainConfigured()) {
    const api = await fetchDomainListing(source.listing_id);
    if (api.status === "ok" && api.parsed) fromApi = api.parsed;
  }
  let fetched: FetchResult = fromApi
    ? { status: "ok", httpStatus: 200, html: "", finalUrl: source.url }
    : await fetchListing(source.url);
  if (fetched.status !== "ok" && providedHtml && providedHtml.length > 2000 && !BLOCK_MARKERS.slice(0, 2).some((m) => m.test(providedHtml.slice(0, 5000)))) {
    fetched = { status: "ok", httpStatus: 200, html: providedHtml.slice(0, 3_000_000), finalUrl: source.url };
  }
  const parsed = fromApi ?? (fetched.status === "ok" ? parseListing(fetched.html) : emptyParsed());
  const key = addressKey(parsed.address, parsed.suburb);
  const gotAnything = !!(parsed.address || parsed.rent_pw || parsed.beds);
  const parseStatus: ImportResult["parse_status"] =
    fetched.status !== "ok" || !gotAnything ? "blocked" : coreMissing(parsed) ? "partial" : "ok";
  const message = fetched.status === "ok"
    ? (gotAnything ? null : "The page loaded but didn't contain listing details")
    : fetched.message ?? "Couldn't load the listing";

  // Existing card: same address, or this exact link already saved.
  let existing: Record<string, unknown> | null = null;
  if (key) {
    const { data } = await admin.from("properties").select("*").eq("household_id", householdId).eq("address_key", key).maybeSingle();
    existing = data;
  }
  if (!existing) {
    const { data } = await admin.from("properties").select("*").eq("household_id", householdId)
      .contains("sources", [{ url: source.url }]).limit(1).maybeSingle();
    existing = data;
  }

  let propertyId: string;
  let merged = false;
  if (existing) {
    merged = true;
    propertyId = existing.id as string;
    const update: Record<string, unknown> = {};
    // Fill only what's empty, so nothing either of you edited by hand is overwritten.
    for (const f of COPY_FIELDS) {
      if ((existing[f] === null || existing[f] === "") && parsed[f] !== null) update[f] = parsed[f];
    }
    if (!existing.address_key && key) update.address_key = key;
    if (((existing.photo_urls as string[]) ?? []).length === 0 && parsed.photo_urls.length) update.photo_urls = parsed.photo_urls;
    const sources = (existing.sources as Source[]) ?? [];
    if (!sources.some((s) => s.url === source.url || (s.listing_id && s.listing_id === source.listing_id && s.site === source.site))) {
      update.sources = [...sources, source];
    }
    const after = { ...existing, ...update } as Partial<Parsed>;
    update.missing_fields = missingFields(after);
    if ((existing.parse_status === "blocked" || existing.parse_status === "partial") && parseStatus !== "blocked") {
      update.parse_status = coreMissing(after) ? "partial" : "ok";
    }
    if (Object.keys(update).length) {
      const { error } = await admin.from("properties").update(update).eq("id", propertyId);
      if (error) throw error;
    }
  } else {
    const row: Record<string, unknown> = {
      household_id: householdId,
      created_by: userId,
      address_key: key,
      photo_urls: parsed.photo_urls,
      sources: [source],
      parse_status: parseStatus,
      missing_fields: missingFields(parsed),
      listing_status: parsed.listing_status ?? "active",
      last_checked_at: new Date().toISOString()
    };
    for (const f of COPY_FIELDS) row[f] = parsed[f];
    if (!row.title && !row.address) row.title = `Listing on ${source.site}`;
    const { data, error } = await admin.from("properties").insert(row).select("id").single();
    if (error) throw error;
    propertyId = data.id;
  }

  if (parsed.inspections.length) {
    await admin.from("inspection_times").upsert(
      parsed.inspections.map((i) => ({ ...i, property_id: propertyId, household_id: householdId, origin: "parsed" })),
      { onConflict: "property_id,starts_at", ignoreDuplicates: true }
    );
  }

  const { data: card } = await admin.from("properties").select("address, suburb, title, missing_fields, parse_status").eq("id", propertyId).single();
  const where = card?.address ? `${card.address}${card.suburb ? ", " + card.suburb : ""}` : (card?.title ?? source.site);
  const summary = merged ? `Added the ${source.site} link to ${where}` : parseStatus === "blocked" ? `Saved the link from ${source.site}: add the details in House Hunter` : `Added ${where}`;
  return {
    property_id: propertyId,
    merged,
    parse_status: (card?.parse_status as ImportResult["parse_status"]) ?? parseStatus,
    missing_fields: (card?.missing_fields as string[]) ?? missingFields(parsed),
    message,
    summary
  };
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
