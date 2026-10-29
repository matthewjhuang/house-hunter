// The household's data, kept in memory and live through Supabase Realtime: when one
// of you moves a card, comments or ticks the checklist, the other phone's copy here
// updates and every view that subscribed re-renders.
//
// Writes go straight to Supabase; the Realtime echo of our own write is what updates
// the store, except where we apply it optimistically first (stage moves) so the UI
// responds instantly.
import { supabase } from "./supabaseClient.js";

const state = {
  demo: false, // localhost #demo: sample data, writes stay in memory
  ready: false,
  error: null,
  online: navigator.onLine,
  user: null,
  household: null,
  members: [],
  invites: [],
  properties: new Map(),
  inspections: new Map(),
  comments: new Map(),
  checklist: new Map(),
  changes: new Map()
};

const listeners = new Set();
let channel = null;
let notifyQueued = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const fn of listeners) fn(state);
  });
}

export const store = state;

// Re-render subscribers without a data change (e.g. a view's local UI state changed).
export function touch() {
  notify();
}

const TABLES = {
  properties: "properties",
  inspection_times: "inspections",
  comments: "comments",
  checklist_items: "checklist",
  property_changes: "changes"
};

async function fetchAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select("*").range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

export async function load(user) {
  state.user = user;
  state.error = null;
  try {
    const [household, members, invites, ...lists] = await Promise.all([
      supabase.from("households").select("*").maybeSingle(),
      supabase.from("household_members").select("*"),
      supabase.from("household_invites").select("*"),
      ...Object.keys(TABLES).map(fetchAll)
    ]);
    if (household.error) throw household.error;
    state.household = household.data;
    state.members = members.data ?? [];
    state.invites = invites.data ?? [];
    Object.values(TABLES).forEach((key, i) => {
      state[key] = new Map(lists[i].map((row) => [row.id, row]));
    });
    state.ready = true;
  } catch (err) {
    console.error("load failed", err);
    state.error = navigator.onLine ? "Couldn't load your board. Pull down or reopen the app to try again." : "You're offline.";
  }
  notify();
  listen();
}

function listen() {
  if (channel) supabase.removeChannel(channel);
  channel = supabase.channel("household");
  for (const [table, key] of Object.entries(TABLES)) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
      if (payload.eventType === "DELETE") state[key].delete(payload.old.id);
      else state[key].set(payload.new.id, payload.new);
      notify();
    });
  }
  channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "households" }, (payload) => {
    state.household = payload.new;
    notify();
  });
  channel.on("postgres_changes", { event: "*", schema: "public", table: "household_members" }, async () => {
    const { data } = await supabase.from("household_members").select("*");
    state.members = data ?? state.members;
    notify();
  });
  channel.subscribe((status) => {
    // After a dropped connection (phone asleep, tunnel), reload so nothing is missed.
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setTimeout(() => refresh(), 3000);
  });
}

let lastRefresh = Date.now();
export async function refresh() {
  if (!state.user) return;
  lastRefresh = Date.now();
  await load(state.user);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.user && Date.now() - lastRefresh > 60_000) refresh();
});
window.addEventListener("online", () => { state.online = true; notify(); refresh(); });
window.addEventListener("offline", () => { state.online = false; notify(); });

export function reset() {
  if (channel) supabase.removeChannel(channel);
  channel = null;
  Object.assign(state, { ready: false, user: null, household: null, members: [], invites: [] });
  for (const key of Object.values(TABLES)) state[key] = new Map();
}

// ---------------------------------------------------------------- derived data

export function memberName(userId) {
  if (!userId) return "Someone";
  if (userId === state.user?.id) return "You";
  return state.members.find((m) => m.user_id === userId)?.display_name ?? "Someone";
}

export function me() {
  return state.members.find((m) => m.user_id === state.user?.id) ?? null;
}

export function propertiesIn(stage) {
  return [...state.properties.values()].filter((p) => p.stage === stage).sort((a, b) => b.position - a.position);
}

export function inspectionsFor(propertyId) {
  return [...state.inspections.values()].filter((i) => i.property_id === propertyId).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export function nextInspection(propertyId) {
  const now = Date.now() - 30 * 60 * 1000;
  const upcoming = inspectionsFor(propertyId).filter((i) => new Date(i.starts_at).getTime() > now);
  return upcoming.find((i) => i.booked) ?? upcoming[0] ?? null;
}

export function commentsFor(propertyId) {
  return [...state.comments.values()].filter((c) => c.property_id === propertyId).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function checklistFor(propertyId) {
  return [...state.checklist.values()].filter((c) => c.property_id === propertyId).sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
}

export function changesFor(propertyId) {
  return [...state.changes.values()].filter((c) => c.property_id === propertyId).sort((a, b) => b.detected_at.localeCompare(a.detected_at));
}

export function overBudgetBy(p) {
  const max = state.household?.max_rent_pw;
  return max && p.rent_pw && p.rent_pw > max ? p.rent_pw - max : 0;
}

// ---------------------------------------------------------------- writes

function applyLocal(table, row) {
  state[TABLES[table]].set(row.id, { ...state[TABLES[table]].get(row.id), ...row });
  notify();
}

// Demo mode: apply a write in memory and hand back the merged row.
function demoWrite(table, row) {
  const key = TABLES[table];
  const merged = { ...state[key].get(row.id), ...row, id: row.id ?? crypto.randomUUID() };
  if (!merged.created_at) merged.created_at = new Date().toISOString();
  if (table === "comments" && !merged.author_id) merged.author_id = state.user.id;
  state[key].set(merged.id, merged);
  notify();
  return merged;
}

export function loadDemo(data) {
  Object.assign(state, { demo: true, ready: true, online: true, ...data });
  notify();
}

export async function updateProperty(id, patch) {
  if (state.demo) return demoWrite("properties", { id, ...patch });
  const before = state.properties.get(id);
  applyLocal("properties", { id, ...patch });
  const { data, error } = await supabase.from("properties").update(patch).eq("id", id).select().single();
  if (error) {
    if (before) applyLocal("properties", before);
    throw error;
  }
  applyLocal("properties", data);
  return data;
}

export async function moveTo(id, stage, extra = {}) {
  const p = state.properties.get(id);
  const patch = { stage, position: Date.now() / 1000, ...extra };
  if (stage !== "rejected" && p?.stage === "rejected") Object.assign(patch, { rejected_reason: null, rejected_note: null, rejected_from_stage: null });
  return updateProperty(id, patch);
}

export async function insertProperty(row) {
  if (state.demo) return demoWrite("properties", { position: Date.now() / 1000, photo_urls: [], sources: [], ...row });
  const { data, error } = await supabase.from("properties").insert(row).select().single();
  if (error) throw error;
  applyLocal("properties", data);
  return data;
}

export async function deleteProperty(id) {
  if (state.demo) { state.properties.delete(id); notify(); return; }
  const before = state.properties.get(id);
  state.properties.delete(id);
  notify();
  const { error } = await supabase.from("properties").delete().eq("id", id);
  if (error) {
    if (before) applyLocal("properties", before);
    throw error;
  }
}

export async function upsertRow(table, row) {
  if (state.demo) return demoWrite(table, row);
  const query = row.id ? supabase.from(table).update(row).eq("id", row.id) : supabase.from(table).insert(row);
  const { data, error } = await query.select().single();
  if (error) throw error;
  applyLocal(table, data);
  return data;
}

export async function deleteRow(table, id) {
  const key = TABLES[table];
  if (state.demo) { state[key].delete(id); notify(); return; }
  const before = state[key].get(id);
  state[key].delete(id);
  notify();
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) {
    if (before) applyLocal(table, before);
    throw error;
  }
}

export async function updateHousehold(patch) {
  if (state.demo) { state.household = { ...state.household, ...patch }; notify(); return; }
  const { data, error } = await supabase.from("households").update(patch).eq("id", state.household.id).select().single();
  if (error) throw error;
  state.household = data;
  notify();
}

export async function updateMe(patch) {
  if (state.demo) { state.members = state.members.map((m) => (m.user_id === state.user.id ? { ...m, ...patch } : m)); notify(); return; }
  const { data, error } = await supabase.from("household_members").update(patch).eq("user_id", state.user.id).select().single();
  if (error) throw error;
  state.members = state.members.map((m) => (m.user_id === data.user_id ? data : m));
  notify();
}
