// Settings tab: budget, reminders and notifications, the iOS Shortcut token, who's
// in the household, and signing out.
import { esc, icon, money } from "./format.js";
import { supabase, SUPABASE_URL } from "./supabaseClient.js";
import { store, subscribe, me, updateHousehold, updateMe } from "./store.js";
import { navBar, collapsingTitle, openSheet, toast, showError, confirmDestructive } from "./ui.js";
import { pushStatus, enablePush, disablePush, sendTestPush, isIOS, isStandalone } from "./push.js";
import { openInstallHelp } from "./onboarding.js";

const LEADS = [[15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [120, "2 hours before"], [180, "3 hours before"], [1440, "The day before"]];
let root;
let status = "off";
let hasToken = false;

export function initSettings(el) {
  root = el;
  root.innerHTML = `${navBar({ id: "settings-title", title: "Settings" })}<div id="settings-body"></div>`;
  collapsingTitle(root);
  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  subscribe(() => !root.hidden && render());
}

export async function showSettings() {
  status = await pushStatus().catch(() => "unsupported");
  if (!store.demo) {
    const { data } = await supabase.from("share_tokens").select("user_id").maybeSingle();
    hasToken = !!data;
  }
  render();
}

function render() {
  const body = root.querySelector("#settings-body");
  if (!store.ready || !store.household) {
    body.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    return;
  }
  // Don't re-render under someone typing.
  if (body.contains(document.activeElement) && document.activeElement.matches("input")) return;
  const mine = me();
  const lead = mine?.reminder_lead_minutes ?? 60;
  const statusText = {
    on: "On for this device",
    off: "Off",
    denied: "Blocked in iPhone Settings",
    "needs-install": "Needs House Hunter on your Home Screen",
    unsupported: "Not available in this browser"
  }[status];

  body.innerHTML = `
    <div class="group-header">Budget</div>
    <div class="group">
      <label class="row" for="max-rent"><span class="row-label">Max rent per week</span>
        <input id="max-rent" type="number" inputmode="numeric" min="0" step="10" placeholder="No limit" value="${esc(store.household.max_rent_pw ?? "")}" aria-describedby="budget-help" style="max-width:120px" /></label>
    </div>
    <p class="group-footer" id="budget-help">Cards above this are flagged "Over budget".${store.household.max_rent_pw ? ` Currently ${money(store.household.max_rent_pw)}/wk.` : ""} Shared by both of you.</p>

    <div class="group-header">Inspection reminders</div>
    <div class="group">
      <label class="row" for="lead"><span class="row-label">Remind me</span>
        <select id="lead" style="max-width:190px">${LEADS.map(([m, l]) => `<option value="${m}" ${m === lead ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="row"><span class="row-label">Notifications<div class="t-footnote secondary">${esc(statusText)}</div></span>
        ${status === "on" ? `<button class="btn btn-plain" data-act="push-off">Turn Off</button>` : status === "off" ? `<button class="btn btn-tinted" data-act="push-on">Turn On</button>` : status === "needs-install" ? `<button class="btn btn-tinted" data-act="install">How</button>` : ""}
      </div>
      ${status === "on" ? `<button class="row" data-act="push-test" style="color:var(--tint)">${icon("bell")}<span class="row-label">Send a Test Notification</span></button>` : ""}
    </div>
    <p class="group-footer">Only for inspections you've marked Booked. Each of you sets your own timing.${isIOS() && !isStandalone() ? " On iPhone, notifications need House Hunter added to your Home Screen." : ""}</p>

    <div class="group-header" id="shortcut">Share from REA &amp; Domain</div>
    <div class="group">
      <a class="row" href="./add-to-house-hunter.shortcut" download="Add to House Hunter.shortcut" style="color:var(--tint)">${icon("share")}<span class="row-label">Get the Shortcut</span></a>
      <button class="row" data-act="shortcut-help">${icon("info")}<span class="row-label">How It Works</span>${icon("chevron", "icon chevron")}</button>
      ${hasToken
        ? `<button class="row" data-act="token-new"><span class="row-label" style="color:var(--tint)">Make a New Token</span></button>
           <button class="row btn-destructive" data-act="token-revoke"><span class="row-label">Revoke Token</span></button>`
        : `<button class="row" data-act="token-new"><span class="row-label" style="color:var(--tint)">Create Your Shortcut Token</span></button>`}
    </div>
    <p class="group-footer">The Shortcut adds a listing straight from the Share button in the realestate.com.au and Domain apps. Your token works only for adding listings.</p>

    <div class="group-header">Household</div>
    <div class="group">
      ${store.members.map((m) => `<div class="row"><span class="row-label">${esc(m.display_name)}${m.user_id === store.user.id ? " (you)" : ""}<div class="t-footnote secondary">${esc(m.email)}</div></span></div>`).join("")}
      ${store.invites.filter((i) => !store.members.some((m) => m.email === i.email)).map((i) => `<div class="row"><span class="row-label">${esc(i.display_name)}<div class="t-footnote secondary">${esc(i.email)} · invited, hasn't signed in yet</div></span></div>`).join("")}
      <label class="row" for="my-name"><span class="row-label">Your name</span><input id="my-name" type="text" maxlength="40" value="${esc(mine?.display_name ?? "")}" autocomplete="given-name" style="max-width:160px" /></label>
    </div>

    <div class="group" style="margin-top:32px">
      <button class="row btn-destructive" data-act="sign-out" style="justify-content:center">Sign Out</button>
    </div>
    <p class="group-footer" style="text-align:center;margin-top:16px">House Hunter · Phase 1</p>`;
}

async function onChange(e) {
  try {
    if (e.target.id === "max-rent") {
      const v = e.target.value.trim();
      await updateHousehold({ max_rent_pw: v ? Math.round(Number(v)) : null });
      toast(v ? `Budget set to ${money(v)}/wk` : "Budget cleared");
    } else if (e.target.id === "lead") {
      await updateMe({ reminder_lead_minutes: Number(e.target.value) });
      toast("Reminder time saved");
    } else if (e.target.id === "my-name") {
      const v = e.target.value.trim();
      if (v) await updateMe({ display_name: v });
    }
  } catch (err) {
    showError(err, "Couldn't save that");
  }
}

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    if (act === "push-on") {
      btn.disabled = true;
      await enablePush();
      toast("Reminders are on for this device");
      await showSettings();
    } else if (act === "push-off") {
      await disablePush();
      await showSettings();
    } else if (act === "push-test") {
      await sendTestPush();
      toast("Sent — it should arrive in a few seconds");
    } else if (act === "install") {
      openInstallHelp();
    } else if (act === "shortcut-help") {
      openShortcutHelp(null);
    } else if (act === "token-new") {
      if (hasToken && !(await confirmDestructive("Make a new token?", "The Shortcut on your phone stops working until you paste in the new one.", "Make New"))) return;
      const token = await createToken();
      hasToken = true;
      render();
      openShortcutHelp(token);
    } else if (act === "token-revoke") {
      if (!(await confirmDestructive("Revoke your token?", "Your Shortcut will stop adding listings.", "Revoke"))) return;
      await supabase.from("share_tokens").delete().eq("user_id", store.user.id);
      hasToken = false;
      render();
      toast("Token revoked");
    } else if (act === "sign-out") {
      if (!(await confirmDestructive("Sign out?", "You'll need your password to sign back in.", "Sign Out"))) return;
      await disablePush().catch(() => {});
      await supabase.auth.signOut();
    }
  } catch (err) {
    btn.disabled = false;
    showError(err);
  }
}

async function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { error } = await supabase.from("share_tokens").upsert({ user_id: store.user.id, token_hash: hash }, { onConflict: "user_id" });
  if (error) throw error;
  return token;
}

export function openShortcutHelp(token) {
  const endpoint = `${SUPABASE_URL}/functions/v1/share-listing`;
  openSheet({
    title: "iOS Shortcut",
    left: { label: "Done", bold: true },
    render(body) {
      body.innerHTML = `
        ${token ? `<div class="group-header">Your token</div>
          <div class="group"><div class="token-box" id="token">${esc(token)}</div>
          <button class="row" data-copy="token" style="color:var(--tint)">Copy Token</button></div>
          <p class="group-footer">Shown once. If you lose it, make a new one in Settings.</p>` : ""}
        <div class="group-header">Endpoint</div>
        <div class="group"><div class="token-box" id="endpoint">${esc(endpoint)}</div>
          <button class="row" data-copy="endpoint" style="color:var(--tint)">Copy Endpoint</button></div>
        <div class="group-header">Add it to your iPhone (1 minute)</div>
        <div class="group"><ol class="onboard-steps">
          <li><span class="step-num">1</span><span>${token ? "Copy the token above." : "Create your token in Settings and copy it."}</span></li>
          <li><span class="step-num">2</span><span>On your iPhone, tap <a href="./add-to-house-hunter.shortcut" download="Add to House Hunter.shortcut"><strong>Get the Shortcut</strong></a> → <strong>Download</strong>, then open it from Safari's Downloads (the arrow at the bottom) and tap <strong>Add Shortcut</strong>.</span></li>
          <li><span class="step-num">3</span><span>When it asks, paste your token. Done.</span></li>
        </ol></div>
        <p class="group-footer">If the Shortcut ever stops working, make a new token here and re-add it.</p>
        <details class="group" style="margin-top:12px"><summary class="row" style="color:var(--tint)">Build it by hand instead</summary><ol class="onboard-steps">
          <li><span class="step-num">1</span><span>Open <strong>Shortcuts</strong>, tap <strong>+</strong>, and name it <strong>Add to House Hunter</strong>.</span></li>
          <li><span class="step-num">2</span><span>Tap the name at the top → <strong>Details</strong>, turn on <strong>Show in Share Sheet</strong>, and set it to receive <strong>URLs</strong> and <strong>Text</strong>.</span></li>
          <li><span class="step-num">3</span><span>Add <strong>Get URLs from Input</strong>, then <strong>Get Item from List</strong> (First Item).</span></li>
          <li><span class="step-num">4</span><span>Add <strong>Get Contents of URL</strong> with that item, method GET. This reads the listing on your phone.</span></li>
          <li><span class="step-num">5</span><span>Add another <strong>Get Contents of URL</strong>: URL the endpoint above, method <strong>POST</strong>, header <strong>Authorization</strong> = <code>Bearer</code> + space + your token, Request Body <strong>JSON</strong> with <code>url</code> = the item from step 3 and <code>html</code> = the Contents of URL from step 4.</span></li>
          <li><span class="step-num">6</span><span>Add <strong>Show Notification</strong> with the Contents of URL from step 5.</span></li>
        </ol></details>
        <div class="group-header">Using it</div>
        <div class="group"><div class="row"><span class="row-label">In the REA or Domain app, open a listing, tap <strong>Share</strong> ${icon("share", "share-glyph")}, then <strong>Add to House Hunter</strong>. The card shows up on both your boards in a few seconds.</span></div></div>
        <p class="group-footer">The same steps are in the project README.</p>`;
      body.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-copy]");
        if (!b) return;
        try {
          await navigator.clipboard.writeText(body.querySelector(`#${b.dataset.copy}`).textContent);
          toast("Copied");
        } catch {
          toast("Couldn't copy — select it and copy instead");
        }
      });
    }
  });
}
