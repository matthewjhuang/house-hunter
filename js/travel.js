// Travel times on the property sheet ("Getting around") and the short line on board
// cards. The numbers come from the travel-times Edge Function; either of you can
// type in your own time for a place, which then wins over the calculated one.
import { esc, icon, minutes, distance } from "./format.js";
import { store, touch, travelFor, travelSeconds, upsertRow, ownerKey } from "./store.js";
import { openMenu, toast, showError } from "./ui.js";
import { ownerLabel } from "./places.js";
import { supabase } from "./supabaseClient.js";

const MODE_LABEL = { transit: "Public transport", drive: "Driving" };
let editing = null; // { propertyId, placeId, mode } while typing your own time

export const located = (p) => p.latitude != null && p.longitude != null && (p.geocode_status == null || p.geocode_status === "ok");

function stopName(s) {
  return s.kind === "train" ? `${s.name} Station` : s.name;
}

function stopRow(s) {
  const what = s.kind === "train" ? "Train station" : `Tram stop${s.stop_no ? ` ${s.stop_no}` : ""}`;
  return `<div class="row">
    <span class="place-icon" data-kind="${s.kind}">${icon(s.kind)}</span>
    <span class="row-label">${esc(stopName(s))}<span class="t-footnote secondary">${what} · ${distance(s.distance_m)}</span></span>
    <span class="row-value travel-walk">${icon("walk")}${minutes(s.walk_s)}<span class="visually-hidden"> walk</span></span>
  </div>`;
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
  const stops = p.nearest_stops ?? [];
  const list = travelFor(p.id);
  const rows = [
    ...stops.map(stopRow),
    ...list.map((x) => placeRow(p, x))
  ];
  if (!list.length) rows.push(`<a class="row" href="#/places">${icon("pin")}<span class="row-label">Add your places to see travel times</span>${icon("chevron", "icon chevron")}</a>`);
  return `${header}<div class="group">${rows.join("")}</div>
    <p class="group-footer">Weekday, arriving 8:30am. Car times are estimates with a rush-hour allowance. Tap a place to set your own time or get directions.
      ${store.demo ? "" : `<button class="btn btn-plain inline-link" data-act="recalc">Recalculate</button>`}</p>`;
}

function directionsUrl(p, place, mode) {
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
  if (t.dataset.act === "cancel-time") {
    editing = null;
    touch();
    return true;
  }
  if (t.dataset.act === "recalc") {
    recalculate(p, t);
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
// plus the walk to the nearest stop.
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
  const stop = [...(p.nearest_stops ?? [])].sort((a, b) => a.walk_s - b.walk_s)[0];
  const html = [
    ...parts.map((x) => `<span class="card-travel">${icon(x.byCar ? "car" : "train")}${esc(x.who)} ${esc(x.time)}</span>`),
    stop ? `<span>${icon("walk")}${minutes(stop.walk_s)} to ${esc(stopName(stop))}</span>` : ""
  ].filter(Boolean).join("");
  const label = [
    ...parts.map((x) => `${x.who} ${x.time.replace("~", "about ")} by ${x.byCar ? "car" : "public transport"}`),
    stop ? `${minutes(stop.walk_s)} walk to ${stopName(stop)}` : ""
  ].filter(Boolean).join(", ");
  return { html, label };
}
