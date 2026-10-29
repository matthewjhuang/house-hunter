// Boot, sign-in, navigation and routing. Shared shell only — each tab's logic lives
// in its own module.
//
// Routes (hash-based, so GitHub Pages never needs to know about them and a refresh
// always lands): #/board, #/p/<id>, #/add?url=…, #/map, #/places, #/settings,
// #/settings/shortcut. The manifest's share_target and plain ?url= links are turned
// into #/add on load.
import { supabase, isConfigured } from "./supabaseClient.js";
import { store, load, reset } from "./store.js";
import { initBoard } from "./board.js";
import { initSettings, showSettings } from "./settings.js";
import { openProperty } from "./propertySheet.js";
import { openAdd } from "./addSheet.js";
import { maybeOnboard } from "./onboarding.js";
import { navBar, collapsingTitle, currentSheet, closeMenu } from "./ui.js";
import { icon } from "./format.js";

const authEl = document.getElementById("auth");
const appEl = document.getElementById("app");
const TABS = ["board", "map", "places", "settings"];
let booted = false;
let pendingRoute = null;

// ---------------------------------------------------------------- incoming links

// Share target (Android) and ?url= deep links → #/add?url=…
(function normaliseIncoming() {
  const params = new URLSearchParams(location.search);
  const shared = params.get("url") || params.get("text") || params.get("add");
  if (shared) {
    const url = shared.match(/https?:\/\/\S+/)?.[0];
    history.replaceState(null, "", `${location.pathname}${url ? `#/add?url=${encodeURIComponent(url)}` : "#/board"}`);
  }
})();

// ---------------------------------------------------------------- auth

let authEmail = "";

function showAuth() {
  appEl.hidden = true;
  authEl.hidden = false;
  document.getElementById("auth-email-form").hidden = false;
  document.getElementById("auth-code-form").hidden = true;
  setTimeout(() => document.getElementById("auth-email").focus(), 50);
}

function friendlyAuthError(error) {
  const m = error?.message ?? "";
  if (/database error saving new user|not_invited|signups not allowed/i.test(m)) return "This email isn't on the House Hunter invite list.";
  if (/rate limit|too many|security purposes/i.test(m)) return "Too many codes requested. Wait a minute, then try again.";
  if (/expired|invalid|otp/i.test(m)) return "That code didn't work. Check it, or send a new one.";
  if (!navigator.onLine) return "You're offline. Connect and try again.";
  return m || "Something went wrong. Try again.";
}

document.getElementById("auth-email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("auth-email");
  const errorEl = document.getElementById("auth-email-error");
  const button = document.getElementById("auth-email-submit");
  authEmail = input.value.trim().toLowerCase();
  errorEl.textContent = "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(authEmail)) {
    errorEl.textContent = "Enter your email address.";
    input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Sending…";
  const { error } = await supabase.auth.signInWithOtp({
    email: authEmail,
    options: { emailRedirectTo: `${location.origin}${location.pathname}`, shouldCreateUser: true }
  });
  button.disabled = false;
  button.textContent = "Send Code";
  if (error) {
    errorEl.textContent = friendlyAuthError(error);
    return;
  }
  document.getElementById("auth-email-form").hidden = true;
  document.getElementById("auth-code-form").hidden = false;
  document.getElementById("auth-code-hint").textContent = `We sent a code to ${authEmail}. Type it here — the link in the email only signs in the browser it opens in.`;
  setTimeout(() => document.getElementById("auth-code").focus(), 50);
});

document.getElementById("auth-code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("auth-code");
  const errorEl = document.getElementById("auth-code-error");
  const button = document.getElementById("auth-code-submit");
  const token = input.value.replace(/\D/g, "");
  errorEl.textContent = "";
  if (token.length < 6) {
    errorEl.textContent = "Enter the code from the email.";
    return;
  }
  button.disabled = true;
  const { error } = await supabase.auth.verifyOtp({ email: authEmail, token, type: "email" });
  button.disabled = false;
  if (error) {
    errorEl.textContent = friendlyAuthError(error);
    input.select();
  }
});
document.getElementById("auth-code").addEventListener("input", (e) => {
  const digits = e.target.value.replace(/\D/g, "");
  if (digits.length === 6 || digits.length === 8) document.getElementById("auth-code-form").requestSubmit();
});
document.getElementById("auth-code-back").addEventListener("click", showAuth);

// ---------------------------------------------------------------- app shell

async function showApp(user) {
  authEl.hidden = true;
  appEl.hidden = false;
  if (!booted) {
    booted = true;
    initBoard(document.getElementById("view-board"));
    initPlaceholder(document.getElementById("view-map"), "map", "Map", "map",
      "See every place on a map", "Pins for each rental, coloured by stage, with travel times to your essential places. Coming in Phase 2.");
    initPlaceholder(document.getElementById("view-places"), "places", "Places", "pin",
      "Your essential places", "Add work, the gym and the shops for each of you, then see car and public transport times on every card. Coming in Phase 2.");
    initSettings(document.getElementById("view-settings"));
  }
  route();
  await load(user);
  if (pendingRoute) {
    const r = pendingRoute;
    pendingRoute = null;
    runDeferred(r);
  }
  maybeOnboard();
}

function initPlaceholder(el, id, title, glyph, heading, text) {
  el.innerHTML = `${navBar({ id: `${id}-title`, title })}
    <div class="empty" style="padding-top:12vh">${icon(glyph)}<h2 class="t-title3">${heading}</h2><p>${text}</p></div>`;
  collapsingTitle(el);
}

// ---------------------------------------------------------------- routing

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (/access_token=|error_description=|type=magiclink/.test(hash)) return { tab: "board" };
  const [path, query] = hash.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query ?? "");
  if (parts[0] === "p" && parts[1]) return { tab: "board", property: parts[1] };
  if (parts[0] === "add") return { tab: "board", add: params.get("url") ?? "" };
  if (parts[0] === "settings") return { tab: "settings", section: parts[1] };
  return { tab: TABS.includes(parts[0]) ? parts[0] : "board" };
}

function route() {
  const r = parseRoute();
  closeMenu();
  showTab(r.tab);
  if (r.property || r.add !== undefined) {
    if (store.ready) runDeferred(r);
    else pendingRoute = r;
  } else if (currentSheet() && r.tab !== "board") {
    currentSheet().close({ silent: true });
  }
  if (r.tab === "settings") {
    showSettings().then(() => {
      if (r.section === "shortcut") document.getElementById("shortcut")?.scrollIntoView({ block: "start" });
    });
  }
}

function runDeferred(r) {
  if (r.property) openProperty(r.property);
  else if (r.add !== undefined) {
    history.replaceState(null, "", "#/board");
    openAdd(r.add, { autoStart: !!r.add });
  }
}

// Each tab keeps its own scroll position, like a native tab bar.
const scrollByTab = {};
let currentTab = null;

function showTab(tab) {
  if (currentTab && currentTab !== tab) scrollByTab[currentTab] = window.scrollY;
  const switching = currentTab !== tab;
  currentTab = tab;
  for (const t of TABS) {
    document.getElementById(`view-${t}`).hidden = t !== tab;
    const link = document.querySelector(`.tab[data-tab="${t}"]`);
    if (t === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
    link.setAttribute("aria-selected", String(t === tab));
  }
  document.title = tab === "board" ? "House Hunter" : `${tab[0].toUpperCase()}${tab.slice(1)} · House Hunter`;
  if (switching) window.scrollTo(0, scrollByTab[tab] ?? 0);
}

window.addEventListener("hashchange", () => {
  if (store.user) route();
});


// Tapping the current tab again scrolls to the top, like iOS.
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab && tab.getAttribute("aria-current") === "page") {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
});

// Notification taps from the service worker.
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "navigate" && e.data.url) location.hash = e.data.url.replace(/^.*#/, "#");
});

// ---------------------------------------------------------------- boot

async function boot() {
  // Local design testing: http://localhost:5501/#demo shows sample data, no sign-in.
  if (location.hostname === "localhost" && location.hash === "#demo") {
    const { demoData } = await import("./demo.js");
    const { loadDemo } = await import("./store.js");
    history.replaceState(null, "", "#/board");
    authEl.hidden = true;
    appEl.hidden = false;
    booted = true;
    initBoard(document.getElementById("view-board"));
    initPlaceholder(document.getElementById("view-map"), "map", "Map", "map", "See every place on a map", "Coming in Phase 2.");
    initPlaceholder(document.getElementById("view-places"), "places", "Places", "pin", "Your essential places", "Coming in Phase 2.");
    initSettings(document.getElementById("view-settings"));
    loadDemo(demoData());
    route();
    return;
  }
  if (!isConfigured) {
    document.getElementById("setup-needed").hidden = false;
    return;
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => console.warn("Service worker not registered", err));
  }
  if (/access_token=/.test(location.hash)) {
    // supabase-js has read the magic-link tokens; tidy the URL.
    await supabase.auth.getSession();
    history.replaceState(null, "", `${location.pathname}#/board`);
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) showApp(data.session.user);
  else showAuth();

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session && !store.user) showApp(session.user);
    if (event === "SIGNED_OUT") {
      reset();
      currentSheet()?.close({ silent: true });
      showAuth();
    }
  });
}

boot();
