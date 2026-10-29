// Places tab: the places each of you goes to every week (work, study, the gym,
// family). Every active listing gets public transport and car times to each one.
// Addresses are looked up on the server by travel-times, so a new place shows
// "Finding it on the map…" for a few seconds, then updates live.
import { esc, icon, placeKind, PLACE_KINDS } from "./format.js";
import { store, subscribe, touch, placesSorted, upsertRow, deleteRow, usualMode } from "./store.js";
import { navBar, collapsingTitle, openSheet, openMenu, onLongPress, enableSwipeRows, swipeRow, toast, showError, confirmDestructive } from "./ui.js";

let root, listEl;
let lastHtml = "";

export function initPlaces(el) {
  root = el;
  root.innerHTML = `
    ${navBar({ id: "places-title", title: "Places", actions: `<button class="icon-btn" id="add-place" aria-label="Add place">${icon("plus")}</button>` })}
    <div id="places-body"></div>`;
  listEl = root.querySelector("#places-body");
  collapsingTitle(root);

  root.querySelector("#add-place").addEventListener("click", () => openPlace());
  listEl.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action) {
      const [what, id] = action.split(":");
      if (what === "del-place") deletePlace(id);
      return;
    }
    if (e.target.closest("#first-place")) return openPlace();
    const row = e.target.closest("[data-place]");
    if (row) openPlace(row.dataset.place);
  });
  enableSwipeRows(listEl);
  onLongPress(listEl, "[data-place]", (row) => openMenu(row, [
    { label: "Edit", icon: "pencil", onClick: () => openPlace(row.dataset.place) },
    { label: "Delete", icon: "trash", destructive: true, onClick: () => deletePlace(row.dataset.place) }
  ]));
  subscribe(render);
  render();
}

export function ownerLabel(ownerId) {
  if (!ownerId) return "Both of you";
  return store.members.find((m) => m.user_id === ownerId)?.display_name ?? "Someone";
}

function statusLine(q) {
  if (q.geocode_status === "not_found") return `<span class="place-status warn">${icon("warn")}Address not found. Tap to fix it.</span>`;
  if (q.geocode_status === "approximate") return `<span class="place-status warn">${icon("warn")}Only roughly found. Check the address.</span>`;
  if (q.latitude == null) return `<span class="place-status"><span class="spinner small" aria-hidden="true"></span>Finding it on the map…</span>`;
  const mode = q.travel_mode === "drive" ? "car" : "train";
  return `<span class="t-footnote secondary">${icon(mode)}<span class="visually-hidden">${q.travel_mode === "drive" ? "By car" : "By public transport"}, </span>${esc(q.address)}</span>`;
}

function rowHtml(q) {
  const kind = placeKind(q.kind);
  const inner = `<button class="row place-row" data-place="${q.id}">
      <span class="place-icon" data-kind="${kind.id}">${icon(kind.icon)}</span>
      <span class="row-label">
        <span class="place-name">${esc(q.name)}${q.show_on_cards ? ` <span class="tag">On cards</span>` : ""}</span>
        ${statusLine(q)}
      </span>
      ${icon("chevron", "icon chevron")}
    </button>`;
  return swipeRow(inner, [{ label: "Delete", cls: "delete", action: `del-place:${q.id}` }]);
}

function render() {
  if (!listEl) return;
  let html;
  if (!store.ready) {
    html = `<div class="progress-row" style="justify-content:center"><span class="spinner" aria-hidden="true"></span>Loading</div>`;
  } else if (!store.places.size) {
    html = `<div class="empty" style="padding-top:10vh">${icon("pin")}
      <h2 class="t-title3">Add the places you go every week</h2>
      <p>Work, study, the gym, family. Every listing then shows how long it takes to get there by public transport and by car.</p>
      <button class="btn btn-filled" id="first-place">${icon("plus")}Add a Place</button>
    </div>`;
  } else {
    const groups = new Map();
    for (const q of placesSorted()) {
      const key = q.owner_id ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(q);
    }
    html = [...groups].map(([owner, list]) => `
      <div class="group-header">${esc(ownerLabel(owner || null))}</div>
      <div class="group">${list.map(rowHtml).join("")}</div>`).join("")
      + `<p class="group-footer">Times are for a weekday, arriving 8:30am. Turn on Show on Cards for the one or two places that matter most.</p>`;
  }
  if (html === lastHtml) return;
  lastHtml = html;
  listEl.innerHTML = html;
}

async function deletePlace(id) {
  const q = store.places.get(id);
  if (!q) return;
  const ok = await confirmDestructive(`Delete ${q.name}?`, "Its travel times go from every listing too.");
  if (!ok) return;
  try {
    await deleteRow("places", id);
    // The cascade deletes these on the server; drop them here straight away.
    for (const [key, t] of store.travel) if (t.place_id === id) store.travel.delete(key);
    touch();
    toast(`Deleted ${q.name}`);
  } catch (err) {
    showError(err, "Couldn't delete that place");
  }
}

// ---------------------------------------------------------------- add / edit sheet

export function openPlace(id = null) {
  const q = id ? store.places.get(id) : null;
  if (id && !q) return;
  const isNew = !q;
  let kind = q?.kind ?? "work";
  let owner = q ? q.owner_id ?? "" : store.user?.id ?? "";
  let onCards = q?.show_on_cards ?? true;
  let onCardsTouched = !isNew;
  let mode = q?.travel_mode ?? usualMode(owner || null);
  let modeTouched = !isNew;
  let sheetRef = null;

  const owners = [...store.members.map((m) => ({ id: m.user_id, label: m.display_name })), { id: "", label: "Both" }];

  openSheet({
    title: isNew ? "New Place" : "Edit Place",
    left: { label: "Cancel" },
    right: { label: isNew ? "Add" : "Save", bold: true, onClick: () => save() },
    render(body, sheet) {
      sheetRef = sheet;
      body.innerHTML = `
        <form id="place-form" novalidate>
          <div class="group" style="margin-top:16px">
            <div class="form-row"><label for="p-name">Name</label>
              <input id="p-name" name="name" maxlength="80" value="${esc(q?.name ?? "")}" placeholder="${esc(placeKind(kind).label)}" autocomplete="off" /></div>
            <div class="form-row"><label for="p-address">Address</label>
              <input id="p-address" name="address" maxlength="200" value="${esc(q?.address ?? "")}" placeholder="101 Collins St, Melbourne" autocomplete="street-address" /></div>
          </div>
          ${q?.geocode_status === "not_found" ? `<p class="group-footer" style="color:var(--orange)">This address couldn't be found. Try adding the suburb, or the name of the place.</p>` : `<p class="group-footer">A street address or the name of the place, like "Box Hill Hospital".</p>`}

          <div class="group-header" id="kind-label">Kind</div>
          <div class="chips" role="group" aria-labelledby="kind-label">
            ${PLACE_KINDS.map((k) => `<button type="button" class="chip" data-kind="${k.id}" aria-pressed="${k.id === kind}">${icon(k.icon)}${esc(k.label)}</button>`).join("")}
          </div>

          <div class="group-header" id="owner-label">Whose</div>
          <div style="padding:0 var(--gutter)">
            <div class="segmented wide" role="radiogroup" aria-labelledby="owner-label">
              ${owners.map((o) => `<button type="button" role="radio" data-owner="${o.id}" aria-checked="${o.id === owner}">${esc(o.label)}</button>`).join("")}
            </div>
          </div>

          <div class="group-header" id="mode-label">Usually by</div>
          <div style="padding:0 var(--gutter)">
            <div class="segmented wide" role="radiogroup" aria-labelledby="mode-label">
              ${[["drive", "Car"], ["transit", "Public Transport"]].map(([m, label]) => `<button type="button" role="radio" data-mode="${m}" aria-checked="${m === mode}">${esc(label)}</button>`).join("")}
            </div>
          </div>

          <div class="group" style="margin-top:24px">
            <label class="row" for="p-cards"><span class="row-label">Show on Cards</span>
              <input type="checkbox" role="switch" class="switch" id="p-cards" ${onCards ? "checked" : ""} /></label>
          </div>
          <p class="group-footer">Board cards show the time to this place the way you usually get there. Listings show both.</p>
          <div class="field-error" id="place-error" role="alert"></div>
          ${isNew ? "" : `<div class="group" style="margin-top:32px"><button type="button" class="row btn-destructive" id="p-delete" style="justify-content:center">${icon("trash")}Delete Place</button></div>`}
        </form>`;

      const form = body.querySelector("#place-form");
      form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
      body.querySelectorAll("[data-kind]").forEach((chip) => chip.addEventListener("click", () => {
        kind = chip.dataset.kind;
        body.querySelectorAll("[data-kind]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
        body.querySelector("#p-name").placeholder = placeKind(kind).label;
        // Work and study are what you'd want on the cards; the rest usually aren't.
        if (!onCardsTouched) body.querySelector("#p-cards").checked = onCards = kind === "work" || kind === "study";
      }));
      body.querySelectorAll("[data-owner]").forEach((b) => b.addEventListener("click", () => {
        owner = b.dataset.owner;
        body.querySelectorAll("[data-owner]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        if (!modeTouched) setMode(usualMode(owner || null));
      }));
      const setMode = (m) => {
        mode = m;
        body.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.mode === m)));
      };
      body.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { modeTouched = true; setMode(b.dataset.mode); }));
      body.querySelector("#p-cards").addEventListener("change", (e) => { onCards = e.target.checked; onCardsTouched = true; });
      body.querySelector("#p-delete")?.addEventListener("click", async () => {
        await sheet.close({ silent: true });
        deletePlace(id);
      });
      if (isNew) setTimeout(() => body.querySelector("#p-address").focus(), 400);
    }
  });

  async function save() {
    const body = sheetRef.body;
    const errorEl = body.querySelector("#place-error");
    const address = body.querySelector("#p-address").value.trim();
    const name = body.querySelector("#p-name").value.trim() || placeKind(kind).label;
    errorEl.textContent = "";
    if (address.length < 3) {
      errorEl.textContent = "Add an address so it can go on the map.";
      body.querySelector("#p-address").focus();
      return;
    }
    const row = { name, kind, address, owner_id: owner || null, show_on_cards: onCards, travel_mode: mode };
    sheetRef.setRightDisabled(true);
    try {
      const saved = await upsertRow("places", isNew ? row : { id, ...row });
      if (store.demo && (isNew || address !== q.address)) demoLocate(saved.id);
      sheetRef.close();
      if (isNew) toast(`Added ${name}. Working out travel times…`);
    } catch (err) {
      sheetRef.setRightDisabled(false);
      showError(err, "Couldn't save that place");
    }
  }
}

// #demo has no server, so pretend the address was found somewhere near the city.
function demoLocate(id) {
  const q = store.places.get(id);
  if (q) store.places.set(id, { ...q, latitude: null, longitude: null, geocode_status: null });
  touch();
  setTimeout(() => {
    const now = store.places.get(id);
    if (!now) return;
    store.places.set(id, { ...now, latitude: -37.81 + (Math.random() - 0.5) * 0.08, longitude: 144.96 + (Math.random() - 0.5) * 0.1, geocode_status: "ok" });
    touch();
  }, 1500);
}
