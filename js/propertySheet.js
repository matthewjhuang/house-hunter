// Property detail sheet: photos, key facts, what changed, inspections, agent,
// links, the inspection checklist and the comment thread. Everything saves as you
// go and updates live when the other person changes something.
import {
  esc, icon, money, title, place, stageLabel, inspectionLabel, reasonLabel, availableLabel, dateLabel,
  relativeTime, fullTime, siteName, FIELD_LABELS, melbourneLocalToIso, announce
} from "./format.js";
import {
  store, subscribe, touch, inspectionsFor, commentsFor, checklistFor, changesFor, overBudgetBy, memberName,
  updateProperty, upsertRow, deleteRow
} from "./store.js";
import { openSheet, openMenu, toast, showError, confirmDestructive, onLongPress, enableSwipeRows, swipeRow } from "./ui.js";
import { moveMenuItems, rejectFlow, restore, deleteFlow, setBooked } from "./actions.js";
import { openEdit } from "./editSheet.js";
import { supabase } from "./supabaseClient.js";

let openId = null;
let unsubscribe = null;

export function isOpen(id) {
  return openId === id;
}

export function openProperty(id, { highlightMissing = false } = {}) {
  const p = store.properties.get(id);
  if (!p) {
    if (store.ready) toast("That listing isn't on the board any more");
    return;
  }
  history.replaceState(null, "", `#/p/${id}`);
  openSheet({
    title: p.suburb || "Listing",
    label: title(p),
    left: { label: "Done", bold: true },
    right: { label: "Edit", onClick: () => openEdit(id, { highlightMissing: true }) },
    footer: `<form class="composer" id="composer">
        <label class="visually-hidden" for="comment-input">Add a comment</label>
        <textarea id="comment-input" rows="1" placeholder="Add a comment" enterkeyhint="send"></textarea>
        <button class="icon-btn" type="submit" aria-label="Send comment" disabled>${icon("send")}</button>
      </form>`,
    render: (body, sheet) => setup(id, body, sheet, highlightMissing),
    onClose: () => {
      openId = null;
      unsubscribe?.();
      unsubscribe = null;
      if (location.hash.startsWith(`#/p/${id}`)) history.replaceState(null, "", "#/board");
    }
  });
}

const SECTIONS = ["gallery", "head", "notices", "inspections", "details", "agent", "links", "description", "checklist", "comments", "danger"];

function setup(id, body, sheet, highlightMissing) {
  openId = id;
  body.innerHTML = SECTIONS.map((s) => `<div data-section="${s}"></div>`).join("");
  const cache = new Map();
  const dirty = new Set();

  const paint = () => {
    const p = store.properties.get(id);
    if (!p) { sheet.close(); return; }
    for (const s of SECTIONS) {
      const el = body.querySelector(`[data-section="${s}"]`);
      const html = RENDER[s](p);
      if (cache.get(s) === html) continue;
      // Don't yank a field out from under someone typing in it.
      if (el.contains(document.activeElement) && document.activeElement.matches("input, textarea")) { dirty.add(s); continue; }
      cache.set(s, html);
      el.innerHTML = html;
    }
    sheet.el.querySelector(".sheet-header h2").textContent = p.suburb || "Listing";
  };
  paint();
  unsubscribe = subscribe(paint);
  body.addEventListener("focusout", () => setTimeout(() => { if (dirty.size) { dirty.clear(); paint(); } }, 0));

  const p = store.properties.get(id);
  if (p.has_unseen_changes) updateProperty(id, { has_unseen_changes: false }).catch(() => {});

  body.addEventListener("error", (e) => {
    if (e.target.tagName === "IMG") {
      const ph = document.createElement("div");
      ph.className = "photo-placeholder";
      ph.innerHTML = `${icon("photo")}<span class="visually-hidden">Photo unavailable</span>`;
      e.target.replaceWith(ph);
    }
  }, true);

  body.addEventListener("scroll", galleryCounter, { passive: true, capture: true });

  body.addEventListener("click", (e) => onClick(e, id, body, sheet));

  body.addEventListener("submit", (e) => onSubmit(e, id));
  body.addEventListener("input", (e) => {
    if (e.target.matches(".check-note")) saveNoteSoon(e.target);
  });
  enableSwipeRows(body);
  onLongPress(body, "[data-comment-own], [data-custom-item]", (row) => rowMenu(row));

  setupComposer(sheet.el, id);
  if (highlightMissing) body.querySelector("[data-section='notices'] .notice")?.scrollIntoView({ block: "center" });
}

function galleryCounter(e) {
  const g = e.target;
  if (!g.classList?.contains("gallery")) return;
  const i = Math.round(g.scrollLeft / g.clientWidth) + 1;
  const counter = g.parentElement.querySelector(".gallery-count");
  if (counter) counter.textContent = `${i} / ${g.children.length}`;
}

// ---------------------------------------------------------------- sections

const RENDER = {
  gallery(p) {
    const photos = p.photo_urls ?? [];
    if (!photos.length) return `<div class="gallery-wrap"><div class="gallery" aria-label="No photos"><div class="gallery-item"><div class="photo-placeholder">${icon("photo")}</div></div></div></div>`;
    return `<div class="gallery-wrap">
      <div class="gallery" role="region" aria-label="Photos, ${photos.length}" tabindex="0">
        ${photos.map((u, i) => `<div class="gallery-item"><img src="${esc(u)}" alt="Photo ${i + 1} of ${photos.length}" loading="${i < 2 ? "eager" : "lazy"}" referrerpolicy="no-referrer" /></div>`).join("")}
      </div>
      ${photos.length > 1 ? `<span class="badge gallery-count" aria-hidden="true">1 / ${photos.length}</span>` : ""}
    </div>`;
  },

  head(p) {
    const over = overBudgetBy(p);
    const facts = [
      p.beds != null ? `<span class="fact">${icon("bed")}${p.beds} bed${p.beds === 1 ? "" : "s"}</span>` : "",
      p.baths != null ? `<span class="fact">${icon("bath")}${p.baths} bath${p.baths === 1 ? "" : "s"}</span>` : "",
      p.cars != null ? `<span class="fact">${icon("car")}${p.cars} car${p.cars === 1 ? "" : "s"}</span>` : ""
    ].join("");
    return `<div class="detail-head">
      <div class="card-rent">${p.rent_pw ? `<strong>${money(p.rent_pw)}</strong><span>per week</span>` : `<strong class="secondary">Rent not set</strong>`}</div>
      ${over ? `<div class="over-budget" style="margin-top:4px">${icon("warn")}Over your ${money(store.household.max_rent_pw)} budget by ${money(over)}</div>` : ""}
      <h2>${esc(title(p))}</h2>
      ${place(p) ? `<div class="secondary">${esc(place(p))}${p.state ? ` ${esc(p.state)}` : ""}</div>` : ""}
      ${facts ? `<div class="facts">${facts}</div>` : ""}
      <div class="stage-pill"><span class="dot" style="--dot: var(--stage-${p.stage})"></span>${esc(stageLabel(p.stage))}</div>
    </div>
    <div class="detail-actions">
      ${p.stage === "rejected"
        ? `<button class="btn btn-filled" data-act="restore">${icon("restore")}Restore</button>`
        : `<button class="btn btn-filled" data-act="move">Move to…</button><button class="btn btn-tinted" data-act="reject">Reject</button>`}
    </div>`;
  },

  notices(p) {
    const out = [];
    if (p.stage === "rejected") {
      out.push(`<div class="notice info">${icon("info")}<div><strong>Rejected${p.rejected_reason ? `: ${esc(reasonLabel(p.rejected_reason))}` : ""}</strong>${p.rejected_note ? esc(p.rejected_note) : "Restore it to put it back where it was."}</div></div>`);
    }
    if (p.listing_status && p.listing_status !== "active") {
      const label = { removed: "The listing has been taken down.", leased: "The agent has marked it leased.", under_application: "It's under application." }[p.listing_status];
      out.push(`<div class="notice">${icon("warn")}<div><strong>${esc(label)}</strong>Found by the daily check.</div></div>`);
    }
    const missing = (p.missing_fields ?? []).filter((f) => FIELD_LABELS[f]);
    if ((p.parse_status === "blocked" || p.parse_status === "partial") && missing.length) {
      const site = siteName(p.sources?.[0]?.site ?? "the site");
      out.push(`<div class="notice">${icon("warn")}<div><strong>${p.parse_status === "blocked" ? `${esc(site)} wouldn't share the details` : "Some details are missing"}</strong>
        Open the listing in Safari and tap Share → <strong>Add to House Hunter</strong> to fill them in.
        <div style="display:flex;gap:16px"><button class="btn btn-plain bold" style="padding:0;min-height:40px" data-act="retry">Try Again</button><button class="btn btn-plain" style="padding:0;min-height:40px" data-act="edit">Fill In by Hand</button></div></div></div>`);
    }
    const changes = changesFor(p.id);
    if (changes.length) {
      out.push(`<div class="group-header">Changes</div><div class="group">${changes.map((c) => `
        <div class="row"><div class="row-label">${esc(c.kind === "price" ? "Rent changed" : c.kind === "removed" ? "Listing removed" : "Status changed")}
          <div class="t-footnote secondary">${esc(c.old_value ?? "")}${c.old_value && c.new_value ? " → " : ""}${esc(c.new_value ?? "")}</div></div>
          <span class="row-value t-footnote">${esc(dateLabel(c.detected_at))}</span></div>`).join("")}</div>`);
    }
    return out.join("");
  },

  inspections(p) {
    const list = inspectionsFor(p.id);
    const now = Date.now() - 60 * 60 * 1000;
    const upcoming = list.filter((i) => new Date(i.starts_at).getTime() > now);
    const past = list.filter((i) => new Date(i.starts_at).getTime() <= now).slice(-2);
    const row = (i, isPast) => `<div class="row">
        <div class="row-label">${esc(inspectionLabel(i))}${i.booked ? `<div class="t-footnote" style="color:var(--tint)">Booked${isPast ? "" : " · reminder on"}</div>` : isPast ? `<div class="t-footnote secondary">Past</div>` : ""}</div>
        ${isPast ? "" : `<button class="btn ${i.booked ? "btn-tinted" : "btn-plain"}" data-book="${i.id}" aria-pressed="${i.booked}">${i.booked ? `${icon("check")}Booked` : "Book"}</button>`}
        ${i.origin === "manual" ? `<button class="icon-btn" data-del-insp="${i.id}" aria-label="Remove inspection ${esc(inspectionLabel(i))}">${icon("trash")}</button>` : ""}
      </div>`;
    return `<div class="group-header">Inspections</div>
      <div class="group">
        ${upcoming.map((i) => row(i, false)).join("")}
        ${past.map((i) => row(i, true)).join("")}
        ${!list.length ? `<div class="row"><span class="row-label secondary">No inspection times listed.</span></div>` : ""}
        <form class="row" data-form="add-inspection">
          <label class="visually-hidden" for="insp-time">Inspection date and time</label>
          <input id="insp-time" type="datetime-local" required style="text-align:left" />
          <button class="btn btn-plain bold" type="submit">Add</button>
        </form>
      </div>
      <p class="group-footer">Book a time to get a reminder ${esc(reminderText())} before it starts.</p>`;
  },

  details(p) {
    const rows = [
      p.bond ? ["Bond", money(p.bond)] : null,
      p.available_date ? ["Available", availableLabel(p.available_date).replace("Available ", "")] : null,
      p.property_type ? ["Type", p.property_type] : null
    ].filter(Boolean);
    if (!rows.length) return "";
    return `<div class="group-header">Details</div><div class="group">${rows.map(([k, v]) => `<div class="row"><span class="row-label">${esc(k)}</span><span class="row-value">${esc(v)}</span></div>`).join("")}</div>`;
  },

  agent(p) {
    if (!p.agent_name && !p.agency && !p.agent_phone && !p.agent_email) return "";
    return `<div class="group-header">Agent</div><div class="group">
      <div class="row"><div class="row-label">${esc(p.agent_name ?? "Agent")}${p.agency ? `<div class="t-footnote secondary">${esc(p.agency)}</div>` : ""}</div></div>
      ${p.agent_phone ? `<a class="row" href="tel:${esc(p.agent_phone.replace(/[^\d+]/g, ""))}">${icon("phone")}<span class="row-label">Call ${esc(p.agent_phone)}</span></a>` : ""}
      ${p.agent_email ? `<a class="row" href="mailto:${esc(p.agent_email)}">${icon("mail")}<span class="row-label">Email ${esc(p.agent_email)}</span></a>` : ""}
    </div>`;
  },

  links(p) {
    const sources = p.sources ?? [];
    if (!sources.length) return "";
    return `<div class="group-header">Listing</div><div class="group">
      ${sources.map((s) => `<a class="row" href="${esc(s.url)}" target="_blank" rel="noopener">${icon("link")}<span class="row-label">Open on ${esc(siteName(s.site))}</span>${icon("chevron", "icon chevron")}</a>`).join("")}
    </div>${sources.length > 1 ? `<p class="group-footer">Listed on ${sources.length} sites — merged into one card.</p>` : ""}`;
  },

  description(p) {
    if (!p.description) return "";
    return `<div class="group-header">Description</div><div class="group">
      <div class="description clamped" id="desc">${esc(p.description)}</div>
      <button class="row btn-plain" data-act="more" aria-controls="desc" aria-expanded="false" style="color:var(--tint)">Show More</button>
    </div>`;
  },

  checklist(p) {
    const items = checklistFor(p.id);
    const counts = { good: 0, okay: 0, bad: 0 };
    items.forEach((i) => i.rating && counts[i.rating]++);
    const ratings = [["good", "Good"], ["okay", "Okay"], ["bad", "Bad"]];
    const itemHtml = (i) => {
      const inner = `<div class="check-row" ${i.is_custom ? `data-custom-item="${i.id}"` : ""}>
        <div class="check-top">
          <span class="row-label" id="ci-${i.id}">${esc(i.label)}</span>
          <div class="segmented" role="radiogroup" aria-labelledby="ci-${i.id}">
            ${ratings.map(([v, l]) => `<button type="button" role="radio" data-rate="${i.id}" data-rating="${v}" aria-checked="${i.rating === v}">${l}</button>`).join("")}
          </div>
        </div>
        ${i.note || noteOpen.has(i.id)
          ? `<label class="visually-hidden" for="note-${i.id}">Note for ${esc(i.label)}</label><textarea class="check-note" id="note-${i.id}" data-note="${i.id}" rows="2" placeholder="Note">${esc(i.note ?? "")}</textarea>`
          : `<button type="button" class="btn btn-plain check-note-toggle" data-add-note="${i.id}">Add Note</button>`}
      </div>`;
      return i.is_custom ? swipeRow(inner, [{ label: "Delete", cls: "delete", action: `del-item:${i.id}` }]) : inner;
    };
    return `<div class="group-header">Inspection checklist</div>
      <div class="group">
        <div class="row check-summary" aria-label="${counts.good} good, ${counts.okay} okay, ${counts.bad} bad">
          <span style="color:var(--green)">${counts.good} good</span><span style="color:var(--orange)">${counts.okay} okay</span><span style="color:var(--red)">${counts.bad} bad</span>
          <span class="secondary">${items.length - counts.good - counts.okay - counts.bad} to check</span>
        </div>
        ${items.map((i) => `<div class="row" style="display:block;padding:0">${itemHtml(i)}</div>`).join("")}
        <form class="row" data-form="add-item">
          <label class="visually-hidden" for="new-item">New checklist item</label>
          <input id="new-item" type="text" maxlength="120" placeholder="Add an item, e.g. Dishwasher" style="text-align:left" />
          <button class="btn btn-plain bold" type="submit">Add</button>
        </form>
      </div>`;
  },

  comments(p) {
    const list = commentsFor(p.id);
    const me = store.user?.id;
    const commentHtml = (c) => {
      const own = c.author_id === me;
      const editing = editingComment === c.id;
      const inner = `<div class="comment" ${own ? `data-comment-own="${c.id}"` : ""}>
        <div class="comment-meta"><strong>${esc(memberName(c.author_id))}</strong><time datetime="${c.created_at}" title="${esc(fullTime(c.created_at))}">${esc(relativeTime(c.created_at))}</time>${c.edited_at ? "<span>· edited</span>" : ""}</div>
        ${editing
          ? `<form data-form="edit-comment" data-id="${c.id}"><label class="visually-hidden" for="edit-${c.id}">Edit comment</label><textarea class="check-note" id="edit-${c.id}" rows="3">${esc(c.body)}</textarea>
              <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-plain" data-act="cancel-edit">Cancel</button><button class="btn btn-plain bold" type="submit">Save</button></div></form>`
          : `<div class="comment-body">${esc(c.body)}</div>`}
      </div>`;
      return own && !editing ? swipeRow(inner, [{ label: "Edit", cls: "edit", action: `edit-comment:${c.id}` }, { label: "Delete", cls: "delete", action: `del-comment:${c.id}` }]) : inner;
    };
    return `<div class="group-header">Comments${list.length ? ` (${list.length})` : ""}</div>
      <div class="group">${list.length ? list.map((c) => `<div class="row" style="display:block;padding:0">${commentHtml(c)}</div>`).join("") : `<div class="row"><span class="row-label secondary">No comments yet. Notes from the inspection go well here.</span></div>`}</div>
      <p class="group-footer">Swipe left or long-press your own comments to edit or delete them.</p>`;
  },

  danger() {
    return `<div class="group" style="margin-top:32px"><button class="row btn-destructive" data-act="delete" style="justify-content:center">${icon("trash")}Delete Listing</button></div>`;
  }
};

// Re-runs the import for a card's first link; the server merges anything it can now
// read into this same card (e.g. once the Domain API is set up).
async function retryImport(p, button) {
  const url = p.sources?.[0]?.url;
  if (!url) return;
  button.disabled = true;
  button.textContent = "Reading…";
  try {
    const { data, error } = await supabase.functions.invoke("parse-listing", { body: { url } });
    if (error) throw error;
    toast(data.parse_status === "blocked" ? "Still couldn't read it — the site is blocking us" : "Details filled in");
  } catch (err) {
    showError(err, "Couldn't reach the listing");
  } finally {
    button.disabled = false;
    button.textContent = "Try Again";
  }
}

const noteOpen = new Set();
let editingComment = null;

function reminderText() {
  const m = store.members.find((x) => x.user_id === store.user?.id)?.reminder_lead_minutes ?? 60;
  return m >= 60 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`;
}

// ---------------------------------------------------------------- interactions

async function onClick(e, id, body, sheet) {
  const t = e.target.closest("button, [data-action]");
  if (!t) return;
  const p = store.properties.get(id);
  if (!p) return;

  if (t.dataset.act === "move") {
    openMenu(t, moveMenuItems(p), { title: "Move to" });
  } else if (t.dataset.act === "reject") {
    rejectFlow(id);
  } else if (t.dataset.act === "restore") {
    restore(id);
  } else if (t.dataset.act === "edit") {
    openEdit(id, { highlightMissing: true });
  } else if (t.dataset.act === "retry") {
    retryImport(p, t);
  } else if (t.dataset.act === "more") {
    const desc = body.querySelector("#desc");
    const expanded = desc.classList.toggle("clamped") === false;
    t.textContent = expanded ? "Show Less" : "Show More";
    t.setAttribute("aria-expanded", String(expanded));
  } else if (t.dataset.book) {
    const insp = store.inspections.get(t.dataset.book);
    if (insp) setBooked(insp, !insp.booked);
  } else if (t.dataset.delInsp) {
    deleteRow("inspection_times", t.dataset.delInsp).catch(showError);
  } else if (t.dataset.rate) {
    const item = store.checklist.get(t.dataset.rate);
    const rating = item.rating === t.dataset.rating ? null : t.dataset.rating;
    upsertRow("checklist_items", { id: item.id, rating, updated_by: store.user.id }).catch((err) => showError(err, "Couldn't save that"));
  } else if (t.dataset.addNote) {
    noteOpen.add(t.dataset.addNote);
    touch();
    setTimeout(() => body.querySelector(`#note-${t.dataset.addNote}`)?.focus(), 30);
  } else if (t.dataset.act === "cancel-edit") {
    editingComment = null;
    touch();
  } else if (t.dataset.act === "delete") {
    if (await deleteFlow(id)) sheet.close();
  } else if (t.dataset.action) {
    const [action, rowId] = t.dataset.action.split(":");
    rowAction(action, rowId, id);
  }
}

function rowAction(action, rowId) {
  if (action === "del-comment") {
    confirmDestructive("Delete this comment?", null).then((ok) => ok && deleteRow("comments", rowId).then(() => announce("Comment deleted")).catch(showError));
  } else if (action === "edit-comment") {
    editingComment = rowId;
    touch();
    setTimeout(() => document.getElementById(`edit-${rowId}`)?.focus(), 30);
  } else if (action === "del-item") {
    deleteRow("checklist_items", rowId).catch(showError);
  }
}

function rowMenu(row) {
  if (row.dataset.commentOwn) {
    const cid = row.dataset.commentOwn;
    openMenu(row, [
      { label: "Edit", icon: "pencil", onClick: () => rowAction("edit-comment", cid) },
      { label: "Delete", icon: "trash", destructive: true, onClick: () => rowAction("del-comment", cid) }
    ]);
  } else if (row.dataset.customItem) {
    const iid = row.dataset.customItem;
    openMenu(row, [{ label: "Delete Item", icon: "trash", destructive: true, onClick: () => rowAction("del-item", iid) }]);
  }
}

const noteTimers = new Map();
function saveNoteSoon(textarea) {
  const itemId = textarea.dataset.note;
  clearTimeout(noteTimers.get(itemId));
  noteTimers.set(itemId, setTimeout(() => {
    upsertRow("checklist_items", { id: itemId, note: textarea.value.trim() || null, updated_by: store.user.id }).catch((err) => showError(err, "Couldn't save the note"));
  }, 600));
}

async function onSubmit(e, id) {
  e.preventDefault();
  const form = e.target;
  try {
    if (form.dataset.form === "add-inspection") {
      const input = form.querySelector("input");
      const iso = melbourneLocalToIso(input.value);
      if (!iso) return;
      await upsertRow("inspection_times", { property_id: id, starts_at: iso, origin: "manual" });
      input.value = "";
      toast("Inspection added — tap Book to get a reminder");
    } else if (form.dataset.form === "add-item") {
      const input = form.querySelector("input");
      const label = input.value.trim();
      if (!label) return;
      const max = Math.max(0, ...checklistFor(id).map((i) => i.position));
      await upsertRow("checklist_items", { property_id: id, label, position: max + 1, is_custom: true });
      input.value = "";
      input.focus();
    } else if (form.dataset.form === "edit-comment") {
      const text = form.querySelector("textarea").value.trim();
      if (!text) return;
      editingComment = null;
      await upsertRow("comments", { id: form.dataset.id, body: text, edited_at: new Date().toISOString() });
    }
  } catch (err) {
    showError(err, err?.code === "23505" ? "That inspection time is already listed" : "Couldn't save that");
  }
}

function setupComposer(sheetEl, id) {
  const form = sheetEl.querySelector("#composer");
  const input = form.querySelector("textarea");
  const send = form.querySelector("button");
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    send.disabled = !input.value.trim();
  };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !matchMedia("(pointer: coarse)").matches) && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await upsertRow("comments", { property_id: id, body: text });
      input.value = "";
      grow();
      announce("Comment sent");
      requestAnimationFrame(() => sheetEl.querySelector("[data-section='comments'] .group .row:last-child")?.scrollIntoView({ block: "nearest" }));
    } catch (err) {
      showError(err, "Couldn't send the comment");
      send.disabled = false;
    }
  });
}
