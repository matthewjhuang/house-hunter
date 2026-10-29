// Edit sheet: every field on a card, editable, with whatever the import couldn't
// read marked "Missing". Also used for adding a listing by hand (no id).
import { esc, icon, addressKey, missingFields, siteName } from "./format.js";
import { store, updateProperty, insertProperty } from "./store.js";
import { openSheet, showError, alertDialog, toast } from "./ui.js";

const FIELDS = [
  { group: "Address", rows: [
    { key: "address", label: "Street", placeholder: "3/12 Smith St", autocomplete: "address-line1" },
    { key: "suburb", label: "Suburb", placeholder: "Brunswick", autocomplete: "address-level2" },
    { key: "postcode", label: "Postcode", placeholder: "3056", inputmode: "numeric", maxlength: 4 }
  ] },
  { group: "Rent", rows: [
    { key: "rent_pw", label: "Rent per week", type: "number", placeholder: "$", missingKey: "rent_pw" },
    { key: "bond", label: "Bond", type: "number", placeholder: "$" },
    { key: "available_date", label: "Available", type: "date" }
  ] },
  { group: "Property", rows: [
    { key: "beds", label: "Bedrooms", type: "number", small: true },
    { key: "baths", label: "Bathrooms", type: "number", small: true },
    { key: "cars", label: "Car spaces", type: "number", small: true },
    { key: "property_type", label: "Type", placeholder: "Apartment" }
  ] },
  { group: "Agent", rows: [
    { key: "agent_name", label: "Name", autocomplete: "off" },
    { key: "agency", label: "Agency" },
    { key: "agent_phone", label: "Phone", type: "tel" },
    { key: "agent_email", label: "Email", type: "email" }
  ] }
];
const NUMBER_KEYS = new Set(["rent_pw", "bond", "beds", "baths", "cars"]);

export function openEdit(id, { highlightMissing = false, notice = null } = {}) {
  const p = id ? store.properties.get(id) : null;
  if (id && !p) return;
  const isNew = !p;
  const missing = new Set(highlightMissing && p ? p.missing_fields ?? [] : []);
  let sheetRef = null;

  const backToDetail = async () => {
    if (!isNew) {
      const { openProperty } = await import("./propertySheet.js");
      openProperty(id);
    } else {
      sheetRef?.close();
    }
  };

  openSheet({
    title: isNew ? "New Listing" : "Edit Listing",
    left: { label: "Cancel", onClick: backToDetail },
    right: { label: isNew ? "Add" : "Save", bold: true, onClick: () => save() },
    render(body, sheet) {
      sheetRef = sheet;
      const v = (k) => (p?.[k] ?? "");
      body.innerHTML = `
        ${notice ? `<div class="notice">${icon("warn")}<div><strong>${esc(notice.title)}</strong>${esc(notice.text)}</div></div>` : ""}
        <form id="edit-form" novalidate>
        ${FIELDS.map((g) => `
          <div class="group-header">${esc(g.group)}</div>
          <div class="group">
            ${g.rows.map((f) => `<div class="form-row${missing.has(f.key) ? " missing" : ""}">
              <label for="f-${f.key}">${esc(f.label)}</label>
              <input id="f-${f.key}" name="${f.key}" type="${f.type ?? "text"}" value="${esc(v(f.key))}"
                ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""} ${f.inputmode ? `inputmode="${f.inputmode}"` : ""}
                ${f.type === "number" ? `inputmode="${f.key === "rent_pw" || f.key === "bond" ? "numeric" : "numeric"}" min="0" ${f.small ? 'max="20"' : ""}` : ""}
                ${f.maxlength ? `maxlength="${f.maxlength}"` : ""} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ""} />
            </div>`).join("")}
          </div>`).join("")}
          <div class="group-header">Photos</div>
          <div class="group"><div class="form-row stacked${missing.has("photo_urls") ? " missing" : ""}">
            <label for="f-photos">Image links, one per line</label>
            <textarea id="f-photos" name="photo_urls" rows="3" placeholder="https://…" autocapitalize="off" autocorrect="off" spellcheck="false">${esc((p?.photo_urls ?? []).join("\n"))}</textarea>
          </div></div>
          <p class="group-footer">Only the links are kept — photos aren't copied anywhere.</p>
          <div class="group-header">Listing links</div>
          <div class="group"><div class="form-row stacked">
            <label for="f-sources">One per line</label>
            <textarea id="f-sources" name="sources" rows="2" placeholder="https://www.domain.com.au/…" autocapitalize="off" autocorrect="off" spellcheck="false">${esc((p?.sources ?? []).map((s) => s.url).join("\n"))}</textarea>
          </div></div>
          <div class="group-header">Description</div>
          <div class="group"><div class="form-row stacked">
            <label for="f-description" class="visually-hidden">Description</label>
            <textarea id="f-description" name="description" rows="5">${esc(v("description"))}</textarea>
          </div></div>
          <div class="field-error" id="edit-error" role="alert"></div>
        </form>`;
      body.querySelector("#edit-form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
      const firstMissing = body.querySelector(".form-row.missing input, .form-row.missing textarea");
      setTimeout(() => (firstMissing ?? (isNew ? body.querySelector("#f-address") : null))?.focus({ preventScroll: false }), 400);
    }
  });

  async function save() {
    const form = sheetRef.body.querySelector("#edit-form");
    const data = Object.fromEntries(new FormData(form).entries());
    const errorEl = sheetRef.body.querySelector("#edit-error");
    errorEl.textContent = "";

    const patch = {};
    for (const g of FIELDS) for (const f of g.rows) {
      const raw = (data[f.key] ?? "").trim();
      patch[f.key] = raw === "" ? null : NUMBER_KEYS.has(f.key) ? Math.round(Number(raw.replace(/[$,]/g, ""))) : raw;
      if (NUMBER_KEYS.has(f.key) && raw !== "" && Number.isNaN(patch[f.key])) {
        errorEl.textContent = `${f.label} needs to be a number.`;
        return;
      }
    }
    if (patch.agent_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.agent_email)) {
      errorEl.textContent = "That agent email doesn't look right.";
      return;
    }
    patch.photo_urls = lines(data.photo_urls).filter((u) => /^https?:\/\//i.test(u));
    const oldSources = p?.sources ?? [];
    patch.sources = lines(data.sources).filter((u) => /^https?:\/\//i.test(u)).map((url) => {
      const existing = oldSources.find((s) => s.url === url);
      if (existing) return existing;
      let site = "link";
      try { site = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep "link" */ }
      return { site, url, listing_id: url.match(/-(\d{6,})\/?$/)?.[1] ?? null };
    });
    patch.description = (data.description ?? "").trim() || null;
    patch.address_key = addressKey(patch.address, patch.suburb);
    if (!patch.state && patch.suburb) patch.state = p?.state ?? "VIC";
    patch.missing_fields = missingFields({ ...p, ...patch });
    if (!patch.address && !patch.suburb && !patch.rent_pw && !patch.sources.length) {
      errorEl.textContent = "Add at least an address or a listing link.";
      return;
    }
    // Once you've been through the edit sheet the "Needs details" badge goes, even if
    // some optional fields (photos, agent) are still empty.
    if (p && (p.parse_status === "blocked" || p.parse_status === "partial")) patch.parse_status = patch.missing_fields.length ? "manual" : "ok";

    sheetRef.setRightDisabled(true);
    try {
      let saved;
      if (isNew) {
        saved = await insertProperty({ ...patch, parse_status: "manual", stage: "saved" });
        toast("Added to Saved");
      } else {
        saved = await updateProperty(id, patch);
      }
      const { openProperty } = await import("./propertySheet.js");
      openProperty(saved.id);
    } catch (err) {
      sheetRef.setRightDisabled(false);
      if (err?.code === "23505") {
        const dupe = [...store.properties.values()].find((x) => x.address_key === patch.address_key && x.id !== id);
        const choice = await alertDialog({
          title: "Already on the board",
          message: `You already have a card for ${patch.address}, ${patch.suburb}${dupe ? ` (in ${dupe.stage === "rejected" ? "Rejected" : "your board"})` : ""}.`,
          buttons: [{ label: "Keep Editing", value: false, style: "cancel" }, { label: "Open It", value: true, style: "bold" }]
        });
        if (choice && dupe) (await import("./propertySheet.js")).openProperty(dupe.id);
        return;
      }
      showError(err, "Couldn't save the changes");
    }
  }
}

function lines(text) {
  return String(text ?? "").split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
}

export function blockedNotice(result, url) {
  let site = "The site";
  try { site = siteName(new URL(url).hostname.replace(/^www\./, "")); } catch { /* generic */ }
  if (result.parse_status === "blocked") {
    return { title: `${site} didn't let us read this listing`, text: "The card has the link. Fill in what you can see on the listing — anything left blank stays marked as missing." };
  }
  return { title: "We got most of it", text: "A few details weren't on the page. Fill them in now or later." };
}
