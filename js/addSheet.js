// Add sheet: paste a realestate.com.au / Domain / other listing link and the
// parse-listing Edge Function turns it into a card. If the site blocks us, the card
// still gets made with the link, and the edit sheet opens to fill in the rest.
// Also reached through the #/add?url=… deep link.
import { esc, icon } from "./format.js";
import { supabase } from "./supabaseClient.js";
import { store } from "./store.js";
import { openSheet, toast, showError } from "./ui.js";
import { openEdit } from "./editSheet.js";

const looksLikeUrl = (s) => /^https?:\/\/\S+\.\S+/i.test(s.trim());

export function openAdd(prefill = "", { autoStart = false } = {}) {
  let sheetRef = null;
  let busy = false;

  openSheet({
    title: "Add Listing",
    fit: true,
    left: { label: "Cancel" },
    right: { label: "Add", bold: true, disabled: !looksLikeUrl(prefill), onClick: () => start() },
    render(body, sheet) {
      sheetRef = sheet;
      body.innerHTML = `
        <form class="paste-field" id="add-form" novalidate>
          <label class="visually-hidden" for="add-url">Listing link</label>
          <input id="add-url" type="url" inputmode="url" placeholder="Paste a listing link" value="${esc(prefill)}"
            autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" />
          ${navigator.clipboard?.readText ? `<button type="button" class="btn btn-tinted" id="paste-btn">Paste</button>` : ""}
        </form>
        <div id="add-status" role="status" aria-live="polite"></div>
        <p class="group-footer">REA and Domain usually block reading links, so this saves the card with its address. To get every detail, open the listing in Safari and tap Share → Add to House Hunter.</p>
        <div class="group" style="margin-top:20px">
          <button class="row" id="manual-btn">${icon("pencil")}<span class="row-label">Enter Details by Hand</span>${icon("chevron", "icon chevron")}</button>
        </div>
        <div class="group-header">From the REA or Domain app</div>
        <div class="group"><a class="row" href="#/settings/shortcut">${icon("share")}<span class="row-label">Set up the Share Sheet Shortcut</span>${icon("chevron", "icon chevron")}</a></div>`;

      const input = body.querySelector("#add-url");
      const sync = () => sheet.setRightDisabled(busy || !looksLikeUrl(input.value));
      input.addEventListener("input", sync);
      body.querySelector("#add-form").addEventListener("submit", (e) => { e.preventDefault(); start(); });
      body.querySelector("#paste-btn")?.addEventListener("click", async () => {
        try {
          const text = await navigator.clipboard.readText();
          const url = text.match(/https?:\/\/\S+/)?.[0] ?? text.trim();
          input.value = url;
          sync();
          if (looksLikeUrl(url)) start();
        } catch {
          input.focus();
        }
      });
      body.querySelector("#manual-btn").addEventListener("click", () => openEdit(null));
      body.querySelector('a[href="#/settings/shortcut"]').addEventListener("click", () => sheet.close({ silent: true }));
      if (autoStart && looksLikeUrl(prefill)) setTimeout(start, 350);
      else setTimeout(() => input.focus(), 400);
    }
  });

  async function start() {
    const input = sheetRef.body.querySelector("#add-url");
    const url = input.value.trim().match(/https?:\/\/\S+/)?.[0];
    if (!url || busy) return;
    if (!navigator.onLine) { setStatus(`<p class="field-error">You're offline. Connect to add a listing.</p>`); return; }
    busy = true;
    sheetRef.setRightDisabled(true);
    input.disabled = true;
    setStatus(`<div class="progress-row"><span class="spinner" aria-hidden="true"></span><span>Reading the listing…</span></div>`);

    try {
      const { data, error } = await supabase.functions.invoke("parse-listing", { body: { url } });
      if (error) {
        let message = "Couldn't add that listing.";
        try { message = (await error.context.json()).error ?? message; } catch { /* keep generic */ }
        throw new Error(message);
      }
      // Wait for the card to arrive (Realtime is usually quicker than this reply).
      await waitForProperty(data.property_id);
      // Blocked sites still get a card (with the address, when the link has it); the
      // card itself explains how to fill in the rest.
      toast(data.parse_status === "blocked" ? "Saved — share it from Safari to fill in the details" : data.merged ? "Filled in the existing card" : "Added to Saved");
      (await import("./propertySheet.js")).openProperty(data.property_id);
    } catch (err) {
      busy = false;
      input.disabled = false;
      sheetRef.setRightDisabled(false);
      setStatus(`<p class="field-error">${esc(err.message || "Couldn't add that listing.")}</p>`);
      if (!err.message) showError(err);
    }
  }

  function setStatus(html) {
    sheetRef.body.querySelector("#add-status").innerHTML = html;
  }
}

async function waitForProperty(id) {
  for (let i = 0; i < 20 && !store.properties.has(id); i++) {
    if (i === 4) {
      const { data } = await supabase.from("properties").select("*").eq("id", id).maybeSingle();
      if (data) { store.properties.set(id, data); return; }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
