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
import { initPlaces } from "./places.js";
import { initMap, showMap } from "./map.js";
import { openProperty } from "./propertySheet.js";
import { openAdd } from "./addSheet.js";
import { maybeOnboard } from "./onboarding.js";
import { currentSheet, closeMenu } from "./ui.js";

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

// Email + password, like Life OS. Only the two invited emails can create an account
// (a database trigger refuses anyone else), and each of you sets a password once.
let creating = false;

function showAuth() {
  appEl.hidden = true;
  authEl.hidden = false;
  setAuthMode(false);
  setTimeout(() => document.getElementById("auth-email").focus(), 50);
}

function setAuthMode(create) {
  creating = create;
  document.getElementById("auth-title").textContent = create ? "Create your password" : "House Hunter";
  document.getElementById("auth-hint").textContent = create
    ? "First time on House Hunter? Use your invited email and choose a password (at least 8 characters)."
    : "Sign in with your email and password.";
  document.getElementById("auth-submit").textContent = create ? "Create Account" : "Sign In";
  document.getElementById("auth-toggle").textContent = create ? "I already have a password" : "First time? Create your password";
  document.getElementById("auth-password").setAttribute("autocomplete", create ? "new-password" : "current-password");
  document.getElementById("auth-error").textContent = "";
}

function friendlyAuthError(error) {
  const m = error?.message ?? "";
  if (/database error saving new user|not_invited|signups not allowed/i.test(m)) return "This email isn't on the House Hunter invite list.";
  if (/already registered|already exists/i.test(m)) return "You already have an account. Sign in instead.";
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/email not confirmed/i.test(m)) return "Email confirmation is still on in Supabase (see the README, step 2).";
  if (/password/i.test(m) && /least|short|weak/i.test(m)) return "Choose a longer password (at least 8 characters).";
  if (/rate limit|too many/i.test(m)) return "Too many tries. Wait a minute, then try again.";
  if (!navigator.onLine) return "You're offline. Connect and try again.";
  return m || "Something went wrong. Try again.";
}

document.getElementById("auth-toggle").addEventListener("click", () => setAuthMode(!creating));

document.getElementById("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("auth-email").value.trim().toLowerCase();
  const password = document.getElementById("auth-password").value;
  const errorEl = document.getElementById("auth-error");
  const button = document.getElementById("auth-submit");
  errorEl.textContent = "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errorEl.textContent = "Enter your email address."; return; }
  if (creating && password.length < 8) { errorEl.textContent = "Choose a password of at least 8 characters."; return; }
  if (!password) { errorEl.textContent = "Enter your password."; return; }

  button.disabled = true;
  const { data, error } = creating
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });
  button.disabled = false;
  if (error) {
    errorEl.textContent = friendlyAuthError(error);
    return;
  }
  // signUp returns no session while Supabase still asks for email confirmation.
  if (creating && !data.session) errorEl.textContent = "Account made, but Supabase still wants an email confirmation. Turn off \"Confirm email\" (README, step 2), then sign in.";
});

// ---------------------------------------------------------------- app shell

async function showApp(user) {
  authEl.hidden = true;
  appEl.hidden = false;
  if (!booted) {
    booted = true;
    initBoard(document.getElementById("view-board"));
    initMap(document.getElementById("view-map"));
    initPlaces(document.getElementById("view-places"));
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

// ---------------------------------------------------------------- routing

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [path, query] = hash.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query ?? "");
  if (parts[0] === "p" && parts[1]) return { tab: "board", property: parts[1] };
  if (parts[0] === "map" && parts[1] === "p" && parts[2]) return { tab: "map", property: parts[2] };
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
  if (r.property) openProperty(r.property, { from: r.tab === "map" ? "map" : "board" });
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
  document.body.classList.toggle("map-tab", tab === "map");
  if (tab === "map") showMap();
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
    initMap(document.getElementById("view-map"));
    initPlaces(document.getElementById("view-places"));
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
