// iOS-style building blocks: sheets, context menus, alerts, toasts, long-press and
// swipe actions. Plain DOM, no framework — each returns a way to close it.
import { esc, icon } from "./format.js";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion() ? 0 : ms));

// ---------------------------------------------------------------- sheets

let current = null; // only one sheet at a time (HIG: never stack sheets)

/**
 * Opens a bottom sheet. `render(body, sheet)` fills it; returns { el, body, close }.
 * options: title, left/right header buttons ({ label, bold, onClick, disabled }),
 *          fit (auto height), onClose, footer (HTML string), label for VoiceOver.
 */
export async function openSheet(options) {
  if (current) await current.close({ silent: true });

  const opener = document.activeElement;
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const el = document.createElement("section");
  el.className = `sheet${options.fit ? " fit" : ""}`;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", options.label ?? options.title ?? "Details");
  el.tabIndex = -1;

  const headerButton = (b, side) =>
    b ? `<button class="btn btn-plain${b.bold ? " bold" : ""}" data-sheet-${side} ${b.disabled ? "disabled" : ""}>${esc(b.label)}</button>` : `<span style="min-width:72px"></span>`;
  el.innerHTML = `
    <div class="sheet-grabber" aria-hidden="true"><span></span></div>
    <header class="sheet-header">
      ${headerButton(options.left, "left")}
      <h2>${esc(options.title ?? "")}</h2>
      ${headerButton(options.right, "right")}
    </header>
    <div class="sheet-body"></div>
    ${options.footer ? `<div class="sheet-footer">${options.footer}</div>` : ""}`;

  document.body.append(scrim, el);
  document.body.classList.add("sheet-open");
  const body = el.querySelector(".sheet-body");

  let closed = false;
  const close = async ({ silent = false } = {}) => {
    if (closed) return;
    closed = true;
    if (current?.el === el) current = null;
    el.classList.remove("show");
    scrim.classList.remove("show");
    document.removeEventListener("keydown", onKey);
    await wait(350);
    el.remove();
    scrim.remove();
    if (!current) document.body.classList.remove("sheet-open");
    if (!silent && opener && document.contains(opener)) opener.focus({ preventScroll: true });
    options.onClose?.({ silent });
  };

  const onKey = (e) => {
    if (e.key === "Escape" && !document.querySelector(".menu, .alert")) close();
  };
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("click", () => close());
  el.querySelector("[data-sheet-left]")?.addEventListener("click", () => (options.left.onClick ?? close)());
  el.querySelector("[data-sheet-right]")?.addEventListener("click", () => options.right.onClick?.());

  enableDragToDismiss(el, close);

  const sheet = { el, body, close, setRightDisabled: (d) => { const b = el.querySelector("[data-sheet-right]"); if (b) b.disabled = d; } };
  current = sheet;
  options.render?.(body, sheet);

  requestAnimationFrame(() => {
    scrim.classList.add("show");
    el.classList.add("show");
    el.focus({ preventScroll: true });
  });
  return sheet;
}

export function currentSheet() {
  return current;
}

function enableDragToDismiss(el, close) {
  const handles = [el.querySelector(".sheet-grabber"), el.querySelector(".sheet-header")];
  const body = el.querySelector(".sheet-body");
  let startY = 0, dy = 0, dragging = false, fromBody = false;

  const start = (e, isBody) => {
    if (window.matchMedia("(min-width: 768px)").matches) return;
    if (isBody && body.scrollTop > 0) return;
    if (e.target.closest("button, input, textarea, select, a")) return;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    dy = 0;
    dragging = true;
    fromBody = isBody;
  };
  const move = (e) => {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dy = Math.max(0, y - startY);
    if (fromBody && dy === 0) return;
    if (fromBody && body.scrollTop > 0) { dragging = false; return; }
    if (dy > 4) {
      el.classList.add("dragging");
      el.style.transform = `translateY(${dy}px)`;
      if (fromBody && e.cancelable) e.preventDefault();
    }
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    el.style.transform = "";
    if (dy > Math.min(160, el.offsetHeight * 0.25)) close();
  };
  for (const h of handles) h.addEventListener("touchstart", (e) => start(e, false), { passive: true });
  body.addEventListener("touchstart", (e) => start(e, true), { passive: true });
  el.addEventListener("touchmove", move, { passive: false });
  el.addEventListener("touchend", end);
  el.addEventListener("touchcancel", end);
}

// ---------------------------------------------------------------- context menu

/**
 * items: [{ label, icon, onClick, destructive, current, separatorBefore, submenu: [...] }]
 * anchor: element the menu points at (it's lifted while the menu is open).
 */
export function openMenu(anchor, items, { title } = {}) {
  closeMenu();
  const scrim = document.createElement("div");
  scrim.className = "menu-scrim";
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  if (title) menu.setAttribute("aria-label", title);

  const render = (list, heading) => {
    menu.innerHTML = (heading ? `<div class="menu-title">${esc(heading)}</div>` : "") +
      list.map((item, i) => `${item.separatorBefore ? '<div class="menu-sep" role="separator"></div>' : ""}
        <button class="menu-item${item.destructive ? " destructive" : ""}" role="menuitem" data-i="${i}" ${item.current ? 'aria-current="true"' : ""}>
          <span>${esc(item.label)}</span>${item.current ? icon("check", "icon check") : item.icon ? icon(item.icon) : item.submenu ? icon("chevron") : ""}
        </button>`).join("");
    menu.querySelectorAll(".menu-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = list[Number(btn.dataset.i)];
        if (item.submenu) { render(item.submenu, item.label); menu.querySelector(".menu-item")?.focus(); return; }
        closeMenu();
        if (!item.current) item.onClick?.();
      });
    });
  };
  render(items, title);
  document.body.append(scrim, menu);
  anchor?.classList.add("lifted");

  // Below the anchor if there's room, otherwise above; kept on screen.
  const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 125, right: innerWidth / 2 + 125, top: innerHeight / 3, bottom: innerHeight / 3 };
  const mh = Math.min(menu.offsetHeight, innerHeight * 0.7);
  const left = Math.min(Math.max(12, r.left), innerWidth - 262);
  let top = r.bottom + 8;
  if (top + mh > innerHeight - 20) top = Math.max(20, r.top - mh - 8);
  if (top < 20) top = 20;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = top < r.top ? "bottom left" : "top left";

  requestAnimationFrame(() => {
    scrim.classList.add("show");
    menu.classList.add("show");
    menu.querySelector(".menu-item")?.focus({ preventScroll: true });
  });
  scrim.addEventListener("click", closeMenu);
  menu.addEventListener("keydown", (e) => {
    const buttons = [...menu.querySelectorAll(".menu-item")];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    if (e.key === "Escape") { e.stopPropagation(); closeMenu(); anchor?.focus(); }
  });
  activeMenu = { scrim, menu, anchor };
}

let activeMenu = null;
export function closeMenu() {
  if (!activeMenu) return;
  const { scrim, menu, anchor } = activeMenu;
  activeMenu = null;
  anchor?.classList.remove("lifted");
  menu.classList.remove("show");
  scrim.classList.remove("show");
  setTimeout(() => { menu.remove(); scrim.remove(); }, reducedMotion() ? 0 : 200);
}

// ---------------------------------------------------------------- alert

/** Resolves to the chosen button's value. buttons: [{ label, value, style: "cancel" | "destructive" | "bold" }] */
export function alertDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = "alert-scrim";
    const el = document.createElement("div");
    el.className = "alert";
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "alert-title");
    el.innerHTML = `<div class="alert-text"><h2 id="alert-title">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ""}</div>
      <div class="alert-buttons">${buttons.map((b, i) => `<button data-i="${i}" class="${b.style === "destructive" ? "destructive" : b.style === "bold" ? "bold" : ""}">${esc(b.label)}</button>`).join("")}</div>`;
    document.body.append(scrim, el);
    const done = (value) => {
      el.classList.remove("show");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => { el.remove(); scrim.remove(); }, 150);
      resolve(value);
    };
    const cancelValue = buttons.find((b) => b.style === "cancel")?.value ?? null;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(cancelValue); } };
    document.addEventListener("keydown", onKey, true);
    el.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => done(buttons[Number(btn.dataset.i)].value)));
    requestAnimationFrame(() => {
      el.classList.add("show");
      (el.querySelector(".alert-buttons button:not(.destructive)") ?? el.querySelector("button")).focus();
    });
  });
}

export function confirmDestructive(title, message, action = "Delete") {
  return alertDialog({
    title,
    message,
    buttons: [
      { label: "Cancel", value: false, style: "cancel" },
      { label: action, value: true, style: "destructive" }
    ]
  });
}

// ---------------------------------------------------------------- toast

let toastTimer = null;
export function toast(message, { undo, duration = 4500 } = {}) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(message)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
  document.body.append(el);
  const hide = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  };
  el.querySelector("button")?.addEventListener("click", () => { hide(); undo(); });
  requestAnimationFrame(() => el.classList.add("show"));
  toastTimer = setTimeout(hide, undo ? Math.max(duration, 6000) : duration);
}

export function showError(err, fallback = "Something went wrong") {
  console.error(err);
  const msg = !navigator.onLine ? "You're offline. Try again when you're connected." : err?.message && err.message.length < 120 ? err.message : fallback;
  toast(msg);
}

// ---------------------------------------------------------------- gestures

/** Long-press (touch) or right-click (pointer) on elements matching selector inside root. */
export function onLongPress(root, selector, handler) {
  let timer = null, startX = 0, startY = 0, fired = false;
  root.addEventListener("touchstart", (e) => {
    const target = e.target.closest(selector);
    if (!target) return;
    fired = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => {
      fired = true;
      handler(target);
    }, 450);
  }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    if (timer && (Math.abs(e.touches[0].clientX - startX) > 8 || Math.abs(e.touches[0].clientY - startY) > 8)) {
      clearTimeout(timer);
      timer = null;
    }
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  root.addEventListener("touchend", (e) => {
    cancel();
    // Swallow the click that follows a long-press.
    if (fired && e.cancelable) e.preventDefault();
  });
  root.addEventListener("touchcancel", cancel);
  root.addEventListener("contextmenu", (e) => {
    const target = e.target.closest(selector);
    if (!target) return;
    e.preventDefault();
    if (!fired) handler(target);
    fired = false;
  });
}

/** Swipe left on a .swipe row to reveal its .swipe-actions. */
export function enableSwipeRows(root) {
  let row = null, startX = 0, startY = 0, dx = 0, decided = false, horizontal = false;
  const closeAll = (except) => root.querySelectorAll(".swipe.open").forEach((r) => {
    if (r !== except) { r.classList.remove("open"); r.querySelector(".swipe-content").style.transform = ""; }
  });
  root.addEventListener("touchstart", (e) => {
    row = e.target.closest(".swipe");
    if (!row || e.target.closest(".swipe-actions")) { if (!e.target.closest(".swipe-actions")) closeAll(); row = null; return; }
    closeAll(row);
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0;
    decided = false;
    horizontal = false;
  }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    if (!row) return;
    const x = e.touches[0].clientX - startX;
    const y = e.touches[0].clientY - startY;
    if (!decided && (Math.abs(x) > 6 || Math.abs(y) > 6)) { decided = true; horizontal = Math.abs(x) > Math.abs(y); }
    if (!horizontal) return;
    const width = row.querySelector(".swipe-actions").offsetWidth;
    const base = row.classList.contains("open") ? -width : 0;
    dx = Math.min(0, Math.max(-width - 30, base + x));
    const content = row.querySelector(".swipe-content");
    content.style.transition = "none";
    content.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  root.addEventListener("touchend", () => {
    if (!row || !horizontal) { row = null; return; }
    const content = row.querySelector(".swipe-content");
    const width = row.querySelector(".swipe-actions").offsetWidth;
    content.style.transition = "";
    const open = dx < -width / 2;
    row.classList.toggle("open", open);
    content.style.transform = open ? `translateX(${-width}px)` : "";
    row = null;
  });
}

export function swipeRow(contentHtml, actions) {
  return `<div class="swipe">
    <div class="swipe-actions" aria-hidden="true">${actions.map((a) => `<button type="button" class="${a.cls}" data-action="${a.action}" tabindex="-1">${esc(a.label)}</button>`).join("")}</div>
    <div class="swipe-content">${contentHtml}</div>
  </div>`;
}

/** Collapse the large title into the nav bar once it scrolls under it. */
export function collapsingTitle(view) {
  const nav = view.querySelector(".nav");
  const large = view.querySelector(".large-title");
  if (!nav || !large) return;
  const observer = new IntersectionObserver(([entry]) => {
    nav.classList.toggle("collapsed", !entry.isIntersecting);
  }, { rootMargin: `-${nav.offsetHeight || 50}px 0px 0px 0px`, threshold: 0 });
  observer.observe(large);
}

export function navBar({ id, title, actions = "" }) {
  return `<header class="nav">
      <div class="nav-row">
        <span class="nav-small-title" aria-hidden="true">${esc(title)}</span>
        <div class="nav-actions">${actions}</div>
      </div>
    </header>
    <h1 class="large-title t-large-title" id="${id}">${esc(title)}</h1>`;
}
