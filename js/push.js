// Web Push for inspection reminders. On iPhone this only works once House Hunter is
// installed to the Home Screen (iOS 16.4+), and the permission prompt has to come
// from a tap — so everything here is started by a button.
import { supabase, VAPID_PUBLIC_KEY } from "./supabaseClient.js";

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** "on" | "off" | "denied" | "needs-install" | "unsupported" */
export async function pushStatus() {
  if (!supported()) return isIOS() && !isStandalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function keyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush() {
  if (!supported()) throw new Error(isIOS() ? "Add House Hunter to your Home Screen first, then turn on notifications from there." : "This browser can't show notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are off. Turn them on in Settings → Notifications → House Hunter.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const json = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, user_agent: navigator.userAgent.slice(0, 200) },
    { onConflict: "endpoint" }
  );
  if (error) throw error;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe();
}

export async function sendTestPush() {
  const { data, error } = await supabase.functions.invoke("send-reminders", { body: { test: true } });
  if (error) {
    let message = "Couldn't send a test notification.";
    try { message = (await error.context.json()).error ?? message; } catch { /* generic */ }
    throw new Error(message);
  }
  if (data?.skipped) throw new Error("Reminders aren't set up on the server yet (VAPID keys missing).");
  return data;
}
