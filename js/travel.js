// Public transport lines, travel times to your places ("Getting around") and Nearby on
// the property sheet, and the short lines on board cards. The numbers come from the travel-times Edge Function; either of you can
// type in your own time for a place, which then wins over the calculated one.
import { esc, icon, minutes, distance, NEARBY_KINDS, SUPERMARKETS } from "./format.js";
import { store, touch, travelFor, travelSeconds, upsertRow, ownerKey } from "./store.js";
import { openMenu, toast, showError } from "./ui.js";
import { ownerLabel } from "./places.js";
import { supabase } from "./supabaseClient.js";

const MODE_LABEL = { transit: "Public transport", drive: "Driving" };
let editing = null; // { propertyId, placeId, mode } while typing your own time

export const located = (p) => p.latitude != null && p.longitude != null && (p.geocode_status == null || p.geocode_status === "ok");

// ---------------------------------------------------------------- public transport

const MODE_NAME = { train: "Train", tram: "Tram", bus: "Bus" };
const expanded = new Set(); // "propertyId:index" of lines showing both directions

// "every 4 min", "every 20 min", "hourly"
export function every(perHour) {
  if (!perHour) return "not in the morning peak";
  if (perHour < 1.5) return "hourly";
  return `every ${Math.round(60 / perHour)} min`;
}

export function clock(iso) {
  return new Date(iso).toLocaleTimeString("en-AU", { timeZone: "Australia/Melbourne", hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
}

// The lines worth showing: a station is dropped when a closer one already has all its
// lines (Auburn and Hawthorn behind Glenferrie).
export function linesFor(p) {
  const lines = p.transit?.lines ?? [];
  const kept = [];
  for (const l of lines) {
    if (l.mode === "train") {
      const mine = l.route.split(" · ");
      if (kept.some((k) => k.mode === "train" && mine.every((r) => k.route.split(" · ").includes(r)))) continue;
    }
    kept.push(l);
  }
  return kept;
}

export const stopLabel = (line) => (line.mode === "train" ? `${line.stop.name} Station` : line.stop.name);

// The two numbers that matter: how often it heads to the city at 8am, and the last
// one coming back the other way at night (roughly when the last one gets you home).
// Lines that don't run to or from the city use their busiest direction instead.
export function lineSummary(line) {
  const toCity = line.dirs.find((d) => d.city);
  const back = toCity ? line.dirs.find((d) => !d.city) : null;
  const busiest = toCity ?? [...line.dirs].sort((a, b) => b.peak - a.peak)[0];
  const lastIso = back ? back.last : line.dirs.map((d) => d.last).filter(Boolean).sort().pop();
  return {
    freq: busiest ? `${every(busiest.peak)} ${toCity ? "to the city" : `to ${busiest.to}`}` : "",
    frequent: (busiest?.peak ?? 0) >= 6,
    last: lastIso ? `last ${back ? "home " : ""}${clock(lastIso)}` : ""
  };
}

export function lineBadge(line) {
  return `<span class="line-badge" data-mode="${line.mode}">${icon(line.mode)}${line.mode === "train" ? "" : `<b>${esc(line.route)}</b>`}</span>`;
}

function lineRow(p, line, i) {
  const { freq, frequent, last } = lineSummary(line);
  const open = expanded.has(`${p.id}:${i}`);
  const title = line.mode === "train" ? stopLabel(line) : `${MODE_NAME[line.mode]} ${line.route}`;
  const where = line.mode === "train" ? `${line.route} line${line.route.includes("·") ? "s" : ""}` : `${line.stop.name}${line.stop.no ? ` · stop ${line.stop.no}` : ""}`;
  return `<button class="row transit-row" data-line="${i}" aria-expanded="${open}">
    ${lineBadge(line)}
    <span class="row-label">${esc(title)}${frequent ? ` <span class="tag">Frequent</span>` : ""}
      <span class="t-footnote secondary">${esc(where)}</span>
      ${freq ? `<span class="t-footnote">${esc(freq[0].toUpperCase() + freq.slice(1))}</span>` : ""}
      ${last ? `<span class="t-footnote secondary">${esc(last[0].toUpperCase() + last.slice(1))}</span>` : ""}
      ${open ? line.dirs.map((d) => `<span class="t-footnote secondary line-dir">To ${esc(d.to)}: ${esc(every(d.peak))} at 8am${d.last ? ` · last ${esc(clock(d.last))}` : ""}</span>`).join("") : ""}
    </span>
    <span class="travel-times"><span>${icon("walk")}<span class="visually-hidden">Walk: </span>${minutes(line.walk_s)}</span><span class="secondary">${distance(line.distance_m)}</span></span>
  </button>`;
}

// Every train station, tram route and frequent bus route within walking distance.
export function transitSection(p) {
  if (p.stage === "rejected" || !located(p)) return "";
  const header = `<div class="group-header">Public transport</div>`;
  if (!p.transit) {
    return `${header}<div class="group"><div class="progress-row"><span class="spinner" aria-hidden="true"></span>Finding the trains, trams and buses nearby…</div></div>`;
  }
  const lines = linesFor(p);
  if (!lines.length) return `${header}<div class="group"><div class="row"><span class="row-label secondary">No train, tram or frequent bus within walking distance.</span></div></div>`;
  return `${header}<div class="group">${lines.map((l, i) => lineRow(p, l, i)).join("")}</div>
    <p class="group-footer">Trains within a 25-minute walk, trams 15, buses 10 if they run at least every 15 min. Frequency is for 7:30–8:30am on a weekday; last services are for a weeknight. Tap a line for both directions.</p>`;
}

// The place's usual mode comes first and in full colour; the other sits under it, dimmed.
function timeHtml(row, mode, placeReady, primary) {
  const secs = travelSeconds(row);
  const glyph = icon(mode === "transit" ? "train" : "car");
  const label = `<span class="visually-hidden">${MODE_LABEL[mode]}: </span>`;
  if (secs != null) {
    const approx = mode === "drive" && row.manual_s == null ? "~" : "";
    return `<span class="${primary ? "" : "secondary"}">${glyph}${label}${approx}${minutes(secs)}${row.manual_s != null ? ` <span class="tag">Yours</span>` : ""}</span>`;
  }
  if (!placeReady) return "";
  if (!row) return `<span class="secondary">${glyph}${label}<span class="spinner small" aria-hidden="true"></span><span class="visually-hidden">Working it out</span></span>`;
  return `<span class="secondary">${glyph}${label}${row.status === "no_route" ? "No route" : "Not available"}</span>`;
}

function placeRow(p, { place, transit, drive }) {
  if (editing?.propertyId === p.id && editing.placeId === place.id) {
    const row = editing.mode === "transit" ? transit : drive;
    const current = travelSeconds(row);
    return `<form class="row manual-time" data-form="manual-time">
      <label for="manual-time">${esc(MODE_LABEL[editing.mode])} to ${esc(place.name)}, door to door</label>
      <span class="manual-time-field"><input id="manual-time" type="number" inputmode="numeric" min="1" max="600" value="${current != null ? Math.round(current / 60) : ""}" required /> min</span>
      <button class="btn btn-plain" type="button" data-act="cancel-time">Cancel</button>
      <button class="btn btn-plain bold" type="submit">Save</button>
    </form>`;
  }
  const placeReady = place.latitude != null && place.geocode_status !== "not_found";
  const sub = !placeReady
    ? place.geocode_status === "not_found" ? "Couldn't find this place's address" : "Finding the place on the map…"
    : place.travel_mode === "drive" ? place.address : transit?.summary ?? place.address;
  const order = place.travel_mode === "drive" ? [["drive", drive], ["transit", transit]] : [["transit", transit], ["drive", drive]];
  return `<button class="row travel-row" data-travel="${place.id}">
    <span class="row-label">${esc(place.name)} <span class="secondary">· ${esc(ownerLabel(ownerKey(place)).replace("Both of you", "Both"))}</span>
      <span class="t-footnote secondary">${esc(sub)}</span></span>
    <span class="travel-times">${order.map(([mode, row], i) => timeHtml(row, mode, placeReady, i === 0)).join("")}</span>
  </button>`;
}

export function travelSection(p) {
  if (p.stage === "rejected") return "";
  const header = `<div class="group-header">Getting around</div>`;
  if (p.geocode_status === "not_found" || p.geocode_status === "approximate") {
    return `${header}<div class="group"><div class="row">${icon("warn")}<span class="row-label">Couldn't pinpoint this address, so there are no travel times yet.
      <span class="t-footnote secondary">Check the street number and suburb.</span></span>
      <button class="btn btn-plain bold" data-act="edit">Edit</button></div></div>`;
  }
  if (!located(p)) {
    if (!p.address) return "";
    return `${header}<div class="group"><div class="progress-row"><span class="spinner" aria-hidden="true"></span>Finding it on the map…</div></div>`;
  }
  const list = travelFor(p.id);
  const rows = list.map((x) => placeRow(p, x));
  if (!list.length) rows.push(`<a class="row" href="#/places">${icon("pin")}<span class="row-label">Add your places to see travel times</span>${icon("chevron", "icon chevron")}</a>`);
  return `${header}<div class="group">${rows.join("")}</div>
    <p class="group-footer">Weekday, arriving 8:30am. Car times are estimates with a rush-hour allowance. Tap a place to set your own time or get directions.
      ${store.demo ? "" : `<button class="btn btn-plain inline-link" data-act="recalc">Recalculate</button>`}</p>`;
}

// ---------------------------------------------------------------- nearby

// The closest Coles, Woolworths, Aldi, Chemist Warehouse and park, by walking time.
// Car times only show when it's more than a 10-minute walk.
export function nearbySection(p) {
  if (p.stage === "rejected" || !located(p)) return "";
  const header = `<div class="group-header">Nearby</div>`;
  if (!p.nearby) {
    return `${header}<div class="group"><div class="progress-row"><span class="spinner" aria-hidden="true"></span>Finding the closest shops and parks…</div></div>`;
  }
  const items = p.nearby.items ?? [];
  if (!items.length) return "";
  const rows = NEARBY_KINDS.map((k) => {
    const x = items.find((i) => i.kind === k.id);
    if (!x) return "";
    const isPark = k.id === "park";
    const title = isPark ? x.name : k.label;
    // "Coles Local", "Woolworths Metro": worth knowing it's a small store.
    const detail = [isPark ? `Park${x.ha ? ` · ${x.ha >= 10 ? Math.round(x.ha) : x.ha} ha` : ""}` : x.name !== k.label ? x.name : "", distance(x.distance_m)].filter(Boolean).join(" · ");
    return `<button class="row travel-row" data-nearby="${k.id}">
      <span class="place-icon" data-kind="${k.id}">${icon(k.icon)}</span>
      <span class="row-label">${esc(title)}<span class="t-footnote secondary">${esc(detail)}</span></span>
      <span class="travel-times">
        <span>${icon("walk")}<span class="visually-hidden">Walk: </span>${minutes(x.walk_s)}</span>
        ${x.drive_s != null && x.walk_s > 600 ? `<span class="secondary">${icon("car")}<span class="visually-hidden">Driving: </span>~${minutes(x.drive_s)}</span>` : ""}
      </span>
    </button>`;
  }).join("");
  return `${header}<div class="group">${rows}</div>
    <p class="group-footer">The closest of each by walking. Stores and parks from OpenStreetMap, updated ${esc(new Date(`${p.nearby.version}T12:00:00`).toLocaleDateString("en-AU", { month: "long", year: "numeric" }))}.</p>`;
}

export function nearbyDirections(p, x) {
  const params = new URLSearchParams({ api: "1", origin: `${p.latitude},${p.longitude}`, destination: `${x.lat},${x.lon}`, travelmode: "walking" });
  return `https://www.google.com/maps/dir/?${params}`;
}

export function directionsUrl(p, place, mode) {
  const params = new URLSearchParams({
    api: "1",
    origin: `${p.latitude},${p.longitude}`,
    destination: place.latitude != null ? `${place.latitude},${place.longitude}` : place.address,
    travelmode: mode === "drive" ? "driving" : "transit"
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

// Returns true when the click was one of ours.
export function onTravelClick(t, p, body) {
  if (t.dataset.line) {
    const key = `${p.id}:${t.dataset.line}`;
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    touch();
    return true;
  }
  if (t.dataset.act === "cancel-time") {
    editing = null;
    touch();
    return true;
  }
  if (t.dataset.act === "recalc") {
    recalculate(p, t);
    return true;
  }
  if (t.dataset.nearby) {
    const x = p.nearby?.items?.find((i) => i.kind === t.dataset.nearby);
    if (x) window.open(nearbyDirections(p, x), "_blank", "noopener");
    return true;
  }
  const placeId = t.dataset.travel;
  if (!placeId) return false;
  const { place, transit, drive } = travelFor(p.id).find((x) => x.place.id === placeId) ?? {};
  if (!place) return true;
  const edit = (mode) => () => {
    editing = { propertyId: p.id, placeId, mode };
    touch();
    setTimeout(() => { const input = body.querySelector("#manual-time"); input?.focus(); input?.select(); }, 30);
  };
  const items = [
    { label: "Directions in Google Maps", icon: "map", onClick: () => window.open(directionsUrl(p, place, place.travel_mode), "_blank", "noopener") }
  ];
  const sets = [
    transit && { label: "Set Public Transport Time", icon: "pencil", onClick: edit("transit") },
    drive && { label: "Set Driving Time", icon: "pencil", onClick: edit("drive") }
  ].filter(Boolean);
  if (place.travel_mode === "drive") sets.reverse();
  if (sets.length) sets[0].separatorBefore = true;
  items.push(...sets);
  const mine = [transit, drive].filter((r) => r?.manual_s != null);
  if (mine.length) {
    items.push({ label: "Use Calculated Times", icon: "restore", onClick: () => Promise.all(mine.map((r) => upsertRow("travel_times", { id: r.id, manual_s: null }))).catch(showError) });
  }
  openMenu(t, items, { title: place.name });
  return true;
}

export async function onTravelSubmit(form, p) {
  if (form.dataset.form !== "manual-time" || !editing) return false;
  const mins = Number(form.querySelector("input").value);
  if (!mins || mins < 1 || mins > 600) return true;
  const { transit, drive } = travelFor(p.id).find((x) => x.place.id === editing.placeId) ?? {};
  const row = editing.mode === "transit" ? transit : drive;
  editing = null;
  // The sheet doesn't repaint a section while one of its fields has focus.
  form.querySelector("input").blur();
  touch();
  if (row) await upsertRow("travel_times", { id: row.id, manual_s: Math.round(mins * 60) });
  return true;
}

async function recalculate(p, button) {
  if (store.demo) { toast("Times are worked out on the server — not in the demo"); return; }
  button.disabled = true;
  try {
    const { error } = await supabase.functions.invoke("travel-times", { body: { property_id: p.id, force: true } });
    if (error) throw error;
    toast("Travel times updated");
  } catch (err) {
    showError(err, "Couldn't work out the times");
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- board cards

// Times to the places marked Show on Cards, each the way that place is usually reached
// and labelled by whose it is ("Matthew ~18 min" by car, "Hannah 58 min" by train),
// plus the trams, trains and buses nearby, and the walk to the closest supermarket
// and park.
export function cardTravel(p) {
  if (p.stage === "rejected" || !located(p)) return { html: "", label: "" };
  const chosen = travelFor(p.id).filter((x) => x.place.show_on_cards).slice(0, 3);
  const ownerCount = (key) => chosen.filter((x) => ownerKey(x.place) === key).length;
  const parts = chosen.map(({ place, transit, drive }) => {
    const byCar = place.travel_mode === "drive";
    const row = byCar ? drive : transit;
    const secs = travelSeconds(row);
    if (secs == null) return null;
    const key = ownerKey(place);
    const who = key && ownerCount(key) === 1 ? ownerLabel(key) : place.name;
    return { who, byCar, time: `${byCar && row.manual_s == null ? "~" : ""}${minutes(secs)}` };
  }).filter(Boolean);
  const closest = (list) => [...list].sort((a, b) => a.walk_s - b.walk_s)[0];
  const lines = linesFor(p);
  const trams = lines.filter((l) => l.mode === "tram").map((l) => l.route);
  const station = lines.find((l) => l.mode === "train");
  const buses = lines.filter((l) => l.mode === "bus").length;
  const items = p.nearby?.items ?? [];
  const shop = closest(items.filter((x) => SUPERMARKETS.includes(x.kind)));
  const park = items.find((x) => x.kind === "park");
  const shopName = shop && NEARBY_KINDS.find((k) => k.id === shop.kind).label;
  const html = [
    ...parts.map((x) => `<span class="card-travel">${icon(x.byCar ? "car" : "train")}${esc(x.who)} ${esc(x.time)}</span>`),
    station ? `<span>${icon("train")}${esc(station.stop.name)} ${minutes(station.walk_s)}</span>` : "",
    trams.length ? `<span>${icon("tram")}${esc(trams.join(" · "))}</span>` : "",
    buses ? `<span>${icon("bus")}${buses} bus${buses === 1 ? "" : "es"}</span>` : "",
    shop ? `<span>${icon("cart")}${esc(shopName)} ${minutes(shop.walk_s)}</span>` : "",
    park ? `<span>${icon("tree")}Park ${minutes(park.walk_s)}</span>` : ""
  ].filter(Boolean).join("");
  const label = [
    ...parts.map((x) => `${x.who} ${x.time.replace("~", "about ")} by ${x.byCar ? "car" : "public transport"}`),
    station ? `${minutes(station.walk_s)} walk to ${stopLabel(station)}` : "",
    trams.length ? `tram${trams.length === 1 ? "" : "s"} ${trams.join(", ")}` : "",
    buses ? `${buses} frequent bus route${buses === 1 ? "" : "s"}` : "",
    shop ? `${minutes(shop.walk_s)} walk to ${shopName}` : "",
    park ? `${minutes(park.walk_s)} walk to ${park.name}` : ""
  ].filter(Boolean).join(", ");
  return { html, label };
}
