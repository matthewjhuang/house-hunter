// Board tab: one column per stage. On a phone you see one stage at a time and swipe
// (or tap the stage picker) between them; from 768pt wide the columns sit side by
// side and cards can be dragged between them.
import { STAGES, REJECTED, ALL_STAGES, esc, icon, money, title, place, inspectionLabel, reasonLabel, stageLabel, availableLabel } from "./format.js";
import { store, subscribe, propertiesIn, nextInspection, commentsFor, overBudgetBy } from "./store.js";
import { navBar, collapsingTitle, onLongPress, openMenu } from "./ui.js";
import { moveWithUndo, moveMenuItems, rejectFlow, restore, deleteFlow, openListing, bookableInspection, setBooked } from "./actions.js";
import { openProperty } from "./propertySheet.js";
import { openAdd } from "./addSheet.js";
import { cardTravel } from "./travel.js";

const wide = window.matchMedia("(min-width: 768px)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
let root, pager, picker;
let active = localStorage.getItem("hh.stage") ?? "saved";
const columnCache = new Map();

export function initBoard(el) {
  root = el;
  root.innerHTML = `
    ${navBar({ id: "board-title", title: "Board", actions: `<button class="icon-btn" id="add-btn" aria-label="Add listing">${icon("plus")}</button>` })}
    <div id="board-banner"></div>
    <div class="stage-picker" role="tablist" aria-label="Stages"></div>
    <div class="pager" id="pager"></div>`;
  pager = root.querySelector("#pager");
  picker = root.querySelector(".stage-picker");
  collapsingTitle(root);

  root.querySelector("#add-btn").addEventListener("click", () => openAdd());
  picker.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-stage]");
    if (chip) showStage(chip.dataset.stage, true);
  });
  picker.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = ALL_STAGES.findIndex((s) => s.id === active);
    const next = ALL_STAGES[(i + (e.key === "ArrowRight" ? 1 : -1) + ALL_STAGES.length) % ALL_STAGES.length];
    showStage(next.id, true);
    picker.querySelector(`[data-stage="${next.id}"]`)?.focus();
  });

  let scrollTimer = null;
  pager.addEventListener("scroll", () => {
    if (wide.matches) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const i = Math.round(pager.scrollLeft / pager.clientWidth);
      const stage = ALL_STAGES[i]?.id;
      if (stage && stage !== active) showStage(stage, false);
    }, 80);
  }, { passive: true });

  pager.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) openProperty(card.dataset.id);
    const add = e.target.closest("[data-empty-add]");
    if (add) openAdd();
  });
  // Photos that fail to load (expired or hot-link protected) show the placeholder.
  pager.addEventListener("error", (e) => {
    if (e.target.tagName === "IMG") e.target.replaceWith(photoPlaceholder());
  }, true);
  onLongPress(pager, ".card", (card) => cardMenu(card));
  enableDragAndDrop();

  subscribe(render);
  wide.addEventListener("change", () => {
    columnCache.clear();
    restored = false;
    if (wide.matches) pager.scrollLeft = 0;
    render();
  });
  if (wide.matches) restored = true;
  render();
}

function photoPlaceholder() {
  const div = document.createElement("div");
  div.className = "photo-placeholder";
  div.innerHTML = icon("house");
  return div;
}

export function showStage(stage, scroll) {
  active = stage;
  localStorage.setItem("hh.stage", stage);
  picker.querySelectorAll("[data-stage]").forEach((c) => c.setAttribute("aria-selected", String(c.dataset.stage === stage)));
  picker.querySelector(`[data-stage="${stage}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  const i = ALL_STAGES.findIndex((s) => s.id === stage);
  if (scroll && !wide.matches) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pager.scrollTo({ left: i * pager.clientWidth, behavior: reduce ? "auto" : "smooth" });
  }
  sizePager();
}

function sizePager() {
  if (wide.matches) { pager.style.height = ""; return; }
  const col = pager.querySelector(`[data-column="${active}"]`);
  if (col) pager.style.height = `${col.offsetHeight}px`;
}

function render() {
  if (!root) return;
  const banner = root.querySelector("#board-banner");
  banner.innerHTML = !store.online
    ? `<div class="banner offline" role="status">${icon("wifi-off")}<span>You're offline. Changes will need a connection.</span></div>`
    : store.error
      ? `<div class="banner" role="alert">${icon("warn")}<span>${esc(store.error)}</span></div>`
      : "";

  picker.innerHTML = ALL_STAGES.map((s) => {
    const count = store.ready ? propertiesIn(s.id).length : "–";
    return `<span class="stage-chip-wrap"><button class="stage-chip${s.id === "rejected" ? " rejected-chip" : ""}" role="tab" data-stage="${s.id}" aria-selected="${s.id === active}" aria-controls="col-${s.id}" aria-label="${esc(s.label)}, ${count}">
      <span class="dot" style="--dot: var(--stage-${s.id})"></span>${esc(s.label)}<span class="count">${count}</span></button></span>`;
  }).join("");

  if (!store.ready) {
    pager.innerHTML = ALL_STAGES.map((s) => `<section class="column" data-column="${s.id}">${s.id === active || wide.matches ? skeletons() : ""}</section>`).join("");
    columnCache.clear();
    requestAnimationFrame(() => restoreScroll());
    return;
  }

  if (!pager.querySelector(".column[data-cached]")) pager.innerHTML = "";
  for (const s of ALL_STAGES) {
    const html = columnHtml(s);
    let col = pager.querySelector(`[data-column="${s.id}"]`);
    if (!col) {
      col = document.createElement("section");
      col.className = `column${s.id === "rejected" ? " rejected-col" : ""}`;
      col.dataset.column = s.id;
      col.dataset.cached = "1";
      col.id = `col-${s.id}`;
      col.setAttribute("role", "tabpanel");
      col.setAttribute("aria-label", s.label);
      pager.append(col);
    }
    if (columnCache.get(s.id) !== html) {
      columnCache.set(s.id, html);
      col.innerHTML = html;
    }
  }
  requestAnimationFrame(() => restoreScroll());
}

let restored = false;
function restoreScroll() {
  if (!restored && !wide.matches) {
    const i = ALL_STAGES.findIndex((s) => s.id === active);
    pager.scrollLeft = i * pager.clientWidth;
    restored = true;
  }
  sizePager();
}

function skeletons() {
  return Array.from({ length: 2 }, () => `<div class="skeleton" aria-hidden="true"><div class="ph"></div><div class="bar"></div><div class="bar short"></div></div>`).join("") + '<span class="visually-hidden">Loading</span>';
}

function columnHtml(stage) {
  const props = propertiesIn(stage.id);
  const head = `<div class="column-head"><span class="dot" style="--dot: var(--stage-${stage.id})"></span>${esc(stage.label)} <span class="count">${props.length}</span></div>`;
  if (!props.length) {
    const first = stage.id === "saved" && store.properties.size === 0;
    return `${head}<div class="empty">
      ${icon(first ? "house" : "board")}
      <h3 class="t-headline">${first ? "No listings yet" : `Nothing in ${esc(stage.label)}`}</h3>
      <p>${first ? "Paste a realestate.com.au or Domain link, or share one from their apps with the Shortcut." : esc(stage.empty)}</p>
      ${first ? `<button class="btn btn-filled" data-empty-add>${icon("plus")} Add a Listing</button>` : ""}
    </div>`;
  }
  return head + props.map(cardHtml).join("");
}

function cardHtml(p) {
  const photo = p.photo_urls?.[0];
  const insp = nextInspection(p.id);
  const comments = commentsFor(p.id).length;
  const over = overBudgetBy(p);
  const badges = [];
  if (p.has_unseen_changes) {
    if (p.listing_status === "removed") badges.push(`<span class="badge gone">Listing removed</span>`);
    else if (p.listing_status === "leased") badges.push(`<span class="badge gone">Leased</span>`);
    else if (p.listing_status === "under_application") badges.push(`<span class="badge change">Under application</span>`);
    else badges.push(`<span class="badge change">${icon("sparkle")}Price changed</span>`);
  } else if (p.listing_status === "removed") {
    badges.push(`<span class="badge gone">Listing removed</span>`);
  }
  if ((p.parse_status === "blocked" || p.parse_status === "partial") && p.missing_fields?.length) {
    badges.push(`<span class="badge warn">${icon("warn")}Needs details</span>`);
  }
  const facts = [
    p.beds !== null && p.beds !== undefined ? `<span class="fact">${icon("bed")}${p.beds}<span class="visually-hidden"> bed${p.beds === 1 ? "" : "s"}</span></span>` : "",
    p.baths !== null && p.baths !== undefined ? `<span class="fact">${icon("bath")}${p.baths}<span class="visually-hidden"> bath${p.baths === 1 ? "" : "s"}</span></span>` : "",
    p.cars !== null && p.cars !== undefined ? `<span class="fact">${icon("car")}${p.cars}<span class="visually-hidden"> car space${p.cars === 1 ? "" : "s"}</span></span>` : ""
  ].join("");
  const travel = cardTravel(p);
  const meta = [
    insp ? `<span class="${insp.booked ? "booked" : ""}">${icon("calendar")} ${insp.booked ? "Booked " : ""}${esc(inspectionLabel(insp))}</span>` : "",
    !insp && p.available_date ? `<span>${esc(availableLabel(p.available_date))}</span>` : "",
    comments ? `<span>${icon("bubble")} ${comments}<span class="visually-hidden"> comment${comments === 1 ? "" : "s"}</span></span>` : "",
    p.stage === "rejected" && p.rejected_reason ? `<span>${esc(reasonLabel(p.rejected_reason))}</span>` : ""
  ].filter(Boolean).join("");

  const label = [
    p.rent_pw ? `${money(p.rent_pw)} per week` : "Rent unknown",
    title(p), p.suburb,
    over ? `Over budget by ${money(over)}` : "",
    insp ? `${insp.booked ? "Booked inspection" : "Next inspection"} ${inspectionLabel(insp)}` : "",
    comments ? `${comments} comments` : "",
    travel.label
  ].filter(Boolean).join(", ");

  return `<button class="card" data-id="${p.id}" ${finePointer.matches ? 'draggable="true"' : ""} aria-label="${esc(label)}" aria-describedby="hint-card">
    <div class="card-photo">
      ${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : `<div class="photo-placeholder">${icon("house")}</div>`}
      ${badges.length ? `<div class="card-badges">${badges.join("")}</div>` : ""}
    </div>
    <div class="card-body">
      <div class="card-rent">${p.rent_pw ? `<strong>${money(p.rent_pw)}</strong><span>/wk</span>` : `<strong class="secondary">Rent?</strong>`}
        ${over ? `<span class="over-budget">${icon("warn")}Over budget by ${money(over)}</span>` : ""}</div>
      <div class="card-address">${esc(title(p))}</div>
      ${place(p) ? `<div class="card-suburb">${esc(place(p))}</div>` : ""}
      ${facts ? `<div class="facts">${facts}</div>` : ""}
      ${travel.html ? `<div class="card-meta card-travel-row">${travel.html}</div>` : ""}
      ${meta ? `<div class="card-meta">${meta}</div>` : ""}
    </div>
  </button>`;
}

function cardMenu(card) {
  const p = store.properties.get(card.dataset.id);
  if (!p) return;
  const bookable = bookableInspection(p.id);
  const items = [
    { label: "Open", onClick: () => openProperty(p.id) },
    p.stage === "rejected"
      ? { label: `Restore to ${stageLabel(p.rejected_from_stage && p.rejected_from_stage !== "rejected" ? p.rejected_from_stage : "saved")}`, icon: "restore", onClick: () => restore(p.id) }
      : { label: "Move to…", submenu: moveMenuItems(p) },
    bookable ? { label: "Book Inspection", icon: "calendar", onClick: () => setBooked(bookable, true) } : null,
    p.sources?.length ? { label: "Open Listing", icon: "link", onClick: () => openListing(p) } : null,
    p.stage !== "rejected" ? { label: "Reject…", icon: "xmark", onClick: () => rejectFlow(p.id) } : null,
    { label: "Delete", icon: "trash", destructive: true, separatorBefore: true, onClick: () => deleteFlow(p.id) }
  ].filter(Boolean);
  openMenu(card, items);
}

function enableDragAndDrop() {
  let dragId = null;
  pager.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  pager.addEventListener("dragend", (e) => {
    e.target.closest?.(".card")?.classList.remove("dragging");
    pager.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target"));
    dragId = null;
  });
  pager.addEventListener("dragover", (e) => {
    const col = e.target.closest(".column");
    if (!col || !dragId) return;
    e.preventDefault();
    pager.querySelectorAll(".drop-target").forEach((c) => c !== col && c.classList.remove("drop-target"));
    col.classList.add("drop-target");
  });
  pager.addEventListener("drop", (e) => {
    const col = e.target.closest(".column");
    if (!col || !dragId) return;
    e.preventDefault();
    col.classList.remove("drop-target");
    const p = store.properties.get(dragId);
    const stage = col.dataset.column;
    if (!p || p.stage === stage) return;
    if (stage === "rejected") rejectFlow(p.id);
    else moveWithUndo(p.id, stage);
  });
}

// Hidden hint read after each card by VoiceOver.
document.body.insertAdjacentHTML("beforeend", `<span id="hint-card" hidden>Opens details. Long-press or use the actions menu to move it.</span>`);
export { STAGES, REJECTED };
