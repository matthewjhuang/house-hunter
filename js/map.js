// Map tab: every listing that isn't Rejected as a price pin in its stage colour, and
// your places as square markers. Tap a pin for a preview, tap the preview to open
// the listing. OpenStreetMap data from OpenFreeMap (free, no key) in its light and
// dark styles, drawn by MapLibre, which loads the first time the tab opens.
import { STAGES, esc, icon, money, title, stageLabel, placeKind } from "./format.js";
import { store, subscribe, placesSorted } from "./store.js";
import { openProperty } from "./propertySheet.js";
import { ownerLabel } from "./places.js";
import { located, cardTravel } from "./travel.js";

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
const markers = new Map(); // id → { marker, el, html }
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
    label: `${q.name}, ${ownerLabel(q.owner_id)}`,
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
        el.addEventListener("click", (e) => e.stopPropagation());
      }
      const marker = new ml.Marker({ element: el, anchor: w.kind === "property" ? "bottom" : "center" }).setLngLat(w.lngLat).addTo(map);
      m = { marker, el, html: "" };
      markers.set(id, m);
    }
    m.marker.setLngLat(w.lngLat);
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
  render();
  const p = id ? store.properties.get(id) : null;
  if (!p) return;
  // Keep the chosen pin clear of the chips and the preview card.
  const pt = map.project([p.longitude, p.latitude]);
  const { clientWidth: w, clientHeight: h } = canvas;
  if (pt.x < PADDING.left || pt.x > w - PADDING.right || pt.y < PADDING.top || pt.y > h - 170) {
    map.easeTo({ center: [p.longitude, p.latitude], offset: [0, -40], duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400 });
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
