// Shared constants and formatting: stages, reasons, money, dates, escaping.

export const STAGES = [
  { id: "saved", label: "Saved", empty: "Paste a listing link to start." },
  { id: "inspection_booked", label: "Inspection booked", empty: "Nothing booked yet." },
  { id: "inspected", label: "Inspected", empty: "Nothing inspected yet." },
  { id: "applied", label: "Applied", empty: "No applications in yet." },
  { id: "approved", label: "Approved", empty: "No approvals yet — fingers crossed." },
  { id: "lease_signed", label: "Lease signed", empty: "This is where the winner goes." }
];
export const REJECTED = { id: "rejected", label: "Rejected", empty: "Nothing rejected. Rejected places can be restored." };
export const ALL_STAGES = [...STAGES, REJECTED];
export const stageLabel = (id) => ALL_STAGES.find((s) => s.id === id)?.label ?? id;

export const REJECT_REASONS = [
  { id: "too_far", label: "Too far" },
  { id: "too_expensive", label: "Too expensive" },
  { id: "condition", label: "Condition" },
  { id: "missed_out", label: "Missed out" },
  { id: "agent_rejected", label: "Agent rejected us" },
  { id: "other", label: "Other" }
];
export const reasonLabel = (id) => REJECT_REASONS.find((r) => r.id === id)?.label ?? "";

export const PLACE_KINDS = [
  { id: "work", label: "Work", icon: "briefcase" },
  { id: "gym", label: "Gym", icon: "gym" },
  { id: "shops", label: "Shops", icon: "cart" },
  { id: "health", label: "Health", icon: "health" },
  { id: "family", label: "Family + Friends", icon: "people" },
  { id: "general", label: "General", icon: "star" }
];
export const placeKind = (id) => PLACE_KINDS.find((k) => k.id === id) ?? PLACE_KINDS[PLACE_KINDS.length - 1];

// "8 min", "1 hr 5 min"
export function minutes(seconds) {
  if (seconds === null || seconds === undefined) return "";
  const m = Math.max(1, Math.round(seconds / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}`;
}

export const distance = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

export const FIELD_LABELS = {
  address: "Address",
  rent_pw: "Rent",
  beds: "Beds",
  baths: "Baths",
  cars: "Car spaces",
  available_date: "Available date",
  bond: "Bond",
  agent_name: "Agent",
  photo_urls: "Photos"
};

const TZ = "Australia/Melbourne";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function icon(name, cls = "icon") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export const money = (n) => (n === null || n === undefined || n === "" ? "" : `$${Number(n).toLocaleString("en-AU")}`);

export function title(p) {
  return p.address || p.title || "Untitled listing";
}

export function place(p) {
  return [p.suburb, p.postcode].filter(Boolean).join(" ");
}

export function siteName(site) {
  if (site === "realestate.com.au") return "realestate.com.au";
  if (site === "domain.com.au") return "Domain";
  return site;
}

export function dateLabel(iso) {
  if (!iso) return "";
  // Dates (YYYY-MM-DD) are calendar days, not instants.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

export function availableLabel(iso) {
  if (!iso) return "";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  return iso <= today ? "Available now" : `Available ${dateLabel(iso)}`;
}

export function inspectionLabel(i) {
  const start = new Date(i.starts_at);
  const day = start.toLocaleDateString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
  const t = (d) => d.toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
  return `${day}, ${t(start)}${i.ends_at ? `–${t(new Date(i.ends_at))}` : ""}`;
}

export function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "now";
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  if (diff < 86400 * 6) return `${Math.round(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function fullTime(iso) {
  return new Date(iso).toLocaleString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// Converts <input type="datetime-local"> (Melbourne wall time) to an ISO instant.
export function melbourneLocalToIso(local) {
  const m = local.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(asUtc)).map((p) => [p.type, p.value])
  );
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(asUtc - (shown - asUtc)).toISOString();
}

const STREET_TYPES = {
  street: "st", road: "rd", avenue: "ave", av: "ave", drive: "dr", court: "ct", place: "pl", crescent: "cres",
  parade: "pde", boulevard: "blvd", lane: "ln", terrace: "tce", highway: "hwy", grove: "gr", close: "cl",
  square: "sq", circuit: "cct", way: "way", walk: "wk", esplanade: "esp", parkway: "pkwy", rise: "rise"
};

// Same normalisation as supabase/functions/_shared/listing.ts addressKey(), so a card
// typed in by hand still merges with the same property imported from a link.
export function addressKey(street, suburb) {
  if (!street || !suburb) return null;
  let s = street.toLowerCase();
  s = s.replace(/\b(unit|apartment|apt|flat|suite|townhouse|villa)\s*/g, "u ");
  s = s.replace(/\bu\s+([0-9a-z]+)\s*,?\s*(\d)/g, "$1/$2");
  s = s.replace(/[.,#]/g, " ").replace(/\s*\/\s*/g, "/");
  s = s.split(/\s+/).filter(Boolean).map((w) => STREET_TYPES[w] ?? w).join(" ");
  const sub = suburb.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  return `${s} ${sub}`.trim();
}

export const MISSING_KEYS = ["address", "rent_pw", "beds", "baths", "cars", "available_date", "bond", "agent_name", "photo_urls"];

export function missingFields(p) {
  return MISSING_KEYS.filter((k) => {
    const v = p[k];
    return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });
}

export function announce(message) {
  const region = document.getElementById("live-region");
  region.textContent = "";
  requestAnimationFrame(() => (region.textContent = message));
}
