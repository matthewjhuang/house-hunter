// Map tab: every listing that isn't Rejected as a price pin in its stage colour, and
// your places as square markers. Tap a pin for a preview, plus its nearest station,
// tram stop, shops and park as small round markers; tap the preview to open the
// listing. Tap a place or a small marker for its details and directions.
// OpenStreetMap data from OpenFreeMap (free, no key) in its light and dark styles,
// drawn by MapLibre, which loads the first time the tab opens.
import { STAGES, NEARBY_KINDS, esc, icon, money, minutes, title, stageLabel, placeKind } from "./format.js";
import { store, subscribe, placesSorted, ownerKey, travelFor, travelSeconds } from "./store.js";
import { openProperty } from "./propertySheet.js";
import { ownerLabel } from "./places.js";
import { located, cardTravel, stopName, nearbyDirections, directionsUrl } from "./travel.js";

const MAPLIBRE = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/";
const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark"
};
const MELBOURNE = [144.9631, -37.8136];
const dark = window.matchMedia("(prefers-color-scheme: dark)");

let root, canvas, chipsEl, previewEl, bannerEl;
let ml = null;
let map = null;
let loading = null;
let fitted = false;
let selected = null;
let popup = null;
const markers = new Map(); // id → { marker, el, html, info }
const hidden = new Set(JSON.parse(localStorage.getItem("hh.mapHidden") ?? "[]"));

export function initMap(el) {
  root = el;
  root.innerHTML = `
    <h1 class="visually-hidden" id="map-title">Map</h1>
    <div class="map-canvas" id="map-canvas" role="region" aria-label="Map of your listings and places"></div>
    <div class="map-top">
      <div class="map-chips" role="group" aria-label="Show on the map"></div>
      <div id="map-banner"></div>
    </div>
    <button class="map-fit icon-btn" id="map-fit" aria-label="Show everything">${icon("locate")}</button>
    <div class="map-preview-wrap" id="map-preview" aria-live="polite"></div>`;
  canvas = root.querySelector("#map-canvas");
  chipsEl = root.querySelector(".map-chips");
  previewEl = root.querySelector("#map-preview");
  bannerEl = root.querySelector("#map-banner");

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    const f = chip.dataset.filter;
    if (hidden.has(f)) hidden.delete(f); else hidden.add(f);
    localStorage.setItem("hh.mapHidden", JSON.stringify([...hidden]));
    render();
  });
  root.querySelector("#map-fit").addEventListener("click", () => fit(true));
  previewEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return select(null);
    const card = e.target.closest("[data-open]");
    if (card) openProperty(card.dataset.open, { from: "map" });
  });
  previewEl.addEventListener("error", (e) => {
    if (e.target.tagName === "IMG") e.target.replaceWith(document.createRange().createContextualFragment(icon("house")));
  }, true);
  subscribe(() => { if (map) render(); });
}

// Called each time the tab is shown.
export async function showMap() {
  if (map) {
    map.resize();
    return;
  }
  canvas.innerHTML = `<div class="progress-row" style="justify-content:center;height:100%"><span class="spinner" aria-hidden="true"></span>Loading the map</div>`;
  try {
    await loadMapLibre();
  } catch {
    canvas.innerHTML = `<div class="empty" style="height:100%;justify-content:center">${icon("map")}
      <h2 class="t-title3">The map needs a connection</h2><p>Connect to the internet, then try again.</p>
      <button class="btn btn-filled" id="map-retry">Try Again</button></div>`;
    canvas.querySelector("#map-retry").addEventListener("click", () => { loading = null; showMap(); });
    return;
  }
  // MapLibre restyles its container, so it gets one of its own inside the fixed frame.
  canvas.innerHTML = `<div id="map-gl"></div>`;
  map = new ml.Map({
    container: canvas.querySelector("#map-gl"),
    style: dark.matches ? STYLES.dark : STYLES.light,
    center: MELBOURNE,
    zoom: 10.5,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new ml.AttributionControl({ compact: false }), "bottom-right");
  dark.addEventListener("change", () => map.setStyle(dark.matches ? STYLES.dark : STYLES.light));
  map.on("click", () => select(null));
  popup = new ml.Popup({ className: "map-info", offset: 18, maxWidth: "280px", focusAfterOpen: false });
  render();
}

function loadMapLibre() {
  if (window.maplibregl) { ml = window.maplibregl; return Promise.resolve(); }
  loading ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${MAPLIBRE}maplibre-gl.min.css`;
    document.head.append(css);
    const script = document.createElement("script");
    script.src = `${MAPLIBRE}maplibre-gl.min.js`;
    script.onload = () => { ml = window.maplibregl; resolve(); };
    script.onerror = () => { script.remove(); reject(new Error("MapLibre didn't load")); };
    document.head.append(script);
  });
  return loading;
}

// ---------------------------------------------------------------- markers

function activeProperties() {
  return [...store.properties.values()].filter((p) => p.stage !== "rejected");
}

function propertyMarker(p) {
  return {
    kind: "property",
    lngLat: [p.longitude, p.latitude],
    html: `<span class="price-pin${selected === p.id ? " selected" : ""}" style="--pin: var(--stage-${p.stage})">${p.rent_pw ? money(p.rent_pw) : icon("house")}</span>`,
    label: `${p.rent_pw ? `${money(p.rent_pw)} per week, ` : ""}${title(p)}, ${stageLabel(p.stage)}`,
    z: selected === p.id ? 3 : 2
  };
}

function placeMarker(q) {
  const kind = placeKind(q.kind);
  return {
    kind: "place",
    lngLat: [q.longitude, q.latitude],
    html: `<span class="place-pin" data-kind="${kind.id}">${icon(kind.icon)}</span>`,
    label: `${q.name}, ${ownerLabel(ownerKey(q))}`,
    info: () => placeInfo(q),
    z: 1
  };
}

function render() {
  const props = activeProperties();
  const places = placesSorted();
  renderChips(props, places);

  const wanted = new Map();
  for (const p of props) {
    if (located(p) && !hidden.has(p.stage)) wanted.set(p.id, propertyMarker(p));
  }
  if (!hidden.has("places")) {
    for (const q of places) {
      if (q.latitude != null && q.geocode_status !== "not_found") wanted.set(q.id, placeMarker(q));
    }
  }
  // The selected listing's nearest station and tram stop, closest shops and park.
  const sp = selected && store.properties.get(selected);
  for (const s of (sp && sp.nearest_stops) || []) {
    if (s.lat == null) continue;
    wanted.set(`stop:${s.kind}`, {
      kind: "nearby",
      lngLat: [s.lon, s.lat],
      html: `<span class="nearby-pin" data-kind="${s.kind}">${icon(s.kind)}</span>`,
      label: `${stopName(s)}, ${minutes(s.walk_s)} walk`,
      info: () => stopInfo(sp, s),
      z: 0
    });
  }
  for (const x of (sp && sp.nearby?.items) || []) {
    const k = NEARBY_KINDS.find((n) => n.id === x.kind);
    if (!k) continue;
    wanted.set(`nearby:${x.kind}`, {
      kind: "nearby",
      lngLat: [x.lon, x.lat],
      html: `<span class="nearby-pin" data-kind="${k.id}">${icon(k.icon)}</span>`,
      label: `${x.name}, ${minutes(x.walk_s)} walk`,
      info: () => nearbyInfo(sp, x, k),
      z: 0
    });
  }

  for (const [id, m] of markers) {
    if (!wanted.has(id)) { m.marker.remove(); markers.delete(id); }
  }
  for (const [id, w] of wanted) {
    let m = markers.get(id);
    if (!m) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `map-marker ${w.kind}`;
      if (w.kind === "property") {
        el.addEventListener("click", (e) => { e.stopPropagation(); select(id); });
      } else {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const info = markers.get(id)?.info;
          if (info) popup.setLngLat(markers.get(id).marker.getLngLat()).setHTML(info()).addTo(map);
        });
      }
      const marker = new ml.Marker({ element: el, anchor: w.kind === "property" ? "bottom" : "center" }).setLngLat(w.lngLat).addTo(map);
      m = { marker, el, html: "" };
      markers.set(id, m);
    }
    m.marker.setLngLat(w.lngLat);
    m.info = w.info;
    if (m.html !== w.html) { m.el.innerHTML = w.html; m.html = w.html; }
    m.el.setAttribute("aria-label", w.label);
    m.el.title = w.label;
    m.el.style.zIndex = w.z;
  }

  if (selected && !wanted.has(selected)) selected = null;
  renderPreview();

  const missing = props.filter((p) => !located(p)).length;
  bannerEl.innerHTML = missing
    ? `<div class="map-banner">${icon("info")}${missing} listing${missing === 1 ? " isn't" : "s aren't"} on the map yet</div>`
    : "";

  if (!fitted && store.ready && wanted.size) { fitted = true; fit(false); }
}

function renderChips(props, places) {
  const present = STAGES.filter((s) => props.some((p) => p.stage === s.id));
  const chips = present.map((s) => {
    const n = props.filter((p) => p.stage === s.id).length;
    return `<button class="map-chip" data-filter="${s.id}" aria-pressed="${!hidden.has(s.id)}"><span class="dot" style="--dot: var(--stage-${s.id})"></span>${esc(s.label)} <span class="count">${n}</span></button>`;
  });
  if (places.length) chips.push(`<button class="map-chip" data-filter="places" aria-pressed="${!hidden.has("places")}">${icon("pin")}Places</button>`);
  const html = chips.join("");
  if (chipsEl.dataset.html !== html) { chipsEl.innerHTML = html; chipsEl.dataset.html = html; }
}

const PADDING = { top: 120, left: 40, right: 40 };

function fit(animate) {
  const points = [...markers.values()].map((m) => m.marker.getLngLat());
  const duration = animate && !matchMedia("(prefers-reduced-motion: reduce)").matches ? 600 : 0;
  if (!points.length) { map.easeTo({ center: MELBOURNE, zoom: 10.5, duration }); return; }
  if (points.length === 1) { map.easeTo({ center: points[0], zoom: 14, duration }); return; }
  const bounds = points.reduce((b, p) => b.extend(p), new ml.LngLatBounds(points[0], points[0]));
  map.fitBounds(bounds, { padding: { ...PADDING, bottom: selected ? 170 : 50 }, maxZoom: 15, duration });
}

// ---------------------------------------------------------------- preview

function select(id) {
  if (selected === id) return;
  selected = id;
  popup?.remove();
  render();
  const p = id ? store.properties.get(id) : null;
  if (!p) return;
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500;
  // Zoom to the listing and its closest shops and park, clear of the chips and preview.
  const items = p.nearby?.items ?? [];
  if (items.length) {
    const bounds = items.reduce((b, x) => b.extend([x.lon, x.lat]), new ml.LngLatBounds([p.longitude, p.latitude], [p.longitude, p.latitude]));
    map.fitBounds(bounds, { padding: { ...PADDING, bottom: 230 }, maxZoom: 16, duration });
    return;
  }
  // Otherwise just keep the chosen pin clear of the chips and the preview card.
  const pt = map.project([p.longitude, p.latitude]);
  const { clientWidth: w, clientHeight: h } = canvas;
  if (pt.x < PADDING.left || pt.x > w - PADDING.right || pt.y < PADDING.top || pt.y > h - 170) {
    map.easeTo({ center: [p.longitude, p.latitude], offset: [0, -40], duration });
  }
}

function renderPreview() {
  const p = selected ? store.properties.get(selected) : null;
  if (!p) { previewEl.innerHTML = ""; previewEl.dataset.html = ""; return; }
  const photo = p.photo_urls?.[0];
  const travel = cardTravel(p);
  const html = `<div class="map-preview">
    <button class="map-preview-body" data-open="${p.id}" aria-label="Open ${esc(title(p))}">
      <span class="map-preview-photo">${photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" />` : icon("house")}</span>
      <span class="map-preview-text">
        <strong>${p.rent_pw ? `${money(p.rent_pw)}/wk · ` : ""}${esc(title(p))}</strong>
        <span class="secondary"><span class="dot" style="--dot: var(--stage-${p.stage})"></span>${esc(stageLabel(p.stage))}${p.suburb ? ` · ${esc(p.suburb)}` : ""}</span>
        ${travel.html ? `<span class="card-meta">${travel.html}</span>` : ""}
      </span>
      ${icon("chevron", "icon chevron")}
    </button>
    <button class="icon-btn map-preview-close" data-close aria-label="Close preview">${icon("xmark")}</button>
  </div>`;
  if (previewEl.dataset.html !== html) { previewEl.innerHTML = html; previewEl.dataset.html = html; }
}

// ---------------------------------------------------------------- tap-for-info cards

function infoCard({ kind, glyph, title, sub, lines, link, linkLabel }) {
  return `<div class="info-head"><span class="place-icon" data-kind="${kind}">${icon(glyph)}</span>
      <div><strong>${esc(title)}</strong>${sub ? `<div class="secondary">${esc(sub)}</div>` : ""}</div></div>
    ${lines.filter(Boolean).map((l) => `<div class="info-line">${l}</div>`).join("")}
    ${link ? `<a class="info-link" href="${esc(link)}" target="_blank" rel="noopener">${esc(linkLabel)}${icon("chevron")}</a>` : ""}`;
}

const from = (p) => `<span class="secondary">From ${esc(title(p))}</span>`;
const walkLine = (walk_s, metres) => `${icon("walk")}${minutes(walk_s)} walk${metres ? ` · ${metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`}` : ""}`;

function stopInfo(p, s) {
  return infoCard({
    kind: s.kind, glyph: s.kind, title: stopName(s),
    sub: s.kind === "train" ? "Train station" : `Tram stop${s.stop_no ? ` ${s.stop_no}` : ""}`,
    lines: [walkLine(s.walk_s, s.distance_m), from(p)],
    link: nearbyDirections(p, s), linkLabel: "Walking directions"
  });
}

function nearbyInfo(p, x, k) {
  const isPark = x.kind === "park";
  return infoCard({
    kind: x.kind, glyph: k.icon, title: isPark ? x.name : k.label,
    sub: isPark ? `Park${x.ha ? ` · ${x.ha} ha` : ""}` : x.name !== k.label ? x.name : "",
    lines: [walkLine(x.walk_s, x.distance_m), x.drive_s != null && x.walk_s > 600 ? `${icon("car")}~${minutes(x.drive_s)} drive` : "", from(p)],
    link: nearbyDirections(p, x), linkLabel: "Walking directions"
  });
}

// A place: whose it is, and with a listing selected, the times from that listing.
function placeInfo(q) {
  const kind = placeKind(q.kind);
  const p = selected && store.properties.get(selected);
  const t = p && travelFor(p.id).find((x) => x.place.id === q.id);
  const line = (row, mode) => {
    const secs = travelSeconds(row);
    if (secs == null) return "";
    const approx = mode === "drive" && row.manual_s == null ? "~" : "";
    return `${icon(mode === "drive" ? "car" : "train")}${approx}${minutes(secs)} ${mode === "drive" ? "drive" : "by public transport"}`;
  };
  const order = q.travel_mode === "drive" ? ["drive", "transit"] : ["transit", "drive"];
  return infoCard({
    kind: kind.id, glyph: kind.icon, title: q.name,
    sub: `${kind.label} · ${ownerLabel(ownerKey(q))}`,
    lines: [
      `<span class="secondary">${esc(q.address)}</span>`,
      ...(t ? order.map((m) => line(t[m], m)) : []),
      t ? from(p) : `<span class="secondary">Tap a listing to see times from it.</span>`
    ],
    link: p ? directionsUrl(p, q, q.travel_mode) : `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: `${q.latitude},${q.longitude}` })}`,
    linkLabel: p ? "Directions from this listing" : "Open in Google Maps"
  });
}
