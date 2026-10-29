// First-run help. In Safari on iPhone: how to add House Hunter to the Home Screen
// (needed for full screen and for notifications). Once installed: ask, with a
// button, whether to turn on inspection reminders.
import { icon } from "./format.js";
import { openSheet, toast, showError } from "./ui.js";
import { isIOS, isStandalone, pushStatus, enablePush } from "./push.js";

const DISMISSED = "hh.onboarding";

export async function maybeOnboard() {
  const seen = JSON.parse(localStorage.getItem(DISMISSED) ?? "{}");
  if (isIOS() && !isStandalone() && !seen.install) {
    openInstallHelp(() => remember("install"));
    return;
  }
  if (isStandalone() && !seen.push && (await pushStatus()) === "off") {
    openPushPrompt(() => remember("push"));
  }
}

function remember(key) {
  const seen = JSON.parse(localStorage.getItem(DISMISSED) ?? "{}");
  seen[key] = true;
  localStorage.setItem(DISMISSED, JSON.stringify(seen));
}

export function openInstallHelp(onClose) {
  let sheetRef = null;
  openSheet({
    title: "Add to Home Screen",
    fit: true,
    right: { label: "Done", bold: true, onClick: () => sheetRef?.close() },
    onClose,
    render(body, sheet) {
      sheetRef = sheet;
      body.innerHTML = `
        <div class="empty" style="padding:16px 24px 8px">${icon("house")}
          <h2 class="t-title2">Install House Hunter</h2>
          <p>It opens full screen like a normal app, and it's the only way iPhone allows inspection reminders.</p></div>
        <div class="group"><ol class="onboard-steps">
          <li><span class="step-num">1</span><span>Tap <strong>Share</strong> ${icon("share", "share-glyph")} in Safari's toolbar.</span></li>
          <li><span class="step-num">2</span><span>Scroll down and tap <strong>Add to Home Screen</strong>.</span></li>
          <li><span class="step-num">3</span><span>Tap <strong>Add</strong>, then open House Hunter from your Home Screen and sign in there.</span></li>
        </ol></div>
        <p class="group-footer">You can keep using it in Safari — reminders just won't be available.</p>`;
    }
  });
}

function openPushPrompt(onClose) {
  openSheet({
    title: "Reminders",
    fit: true,
    left: { label: "Not Now" },
    onClose,
    render(body, sheet) {
      body.innerHTML = `
        <div class="empty" style="padding:16px 24px 8px">${icon("bell")}
          <h2 class="t-title2">Get inspection reminders?</h2>
          <p>We'll notify you an hour before any inspection you've booked. You can change the timing in Settings.</p></div>
        <div style="padding:8px var(--gutter) 16px"><button class="btn btn-filled btn-wide" id="push-yes">Turn On Reminders</button></div>`;
      body.querySelector("#push-yes").addEventListener("click", async (e) => {
        e.target.disabled = true;
        try {
          await enablePush();
          toast("Reminders are on");
          sheet.close();
        } catch (err) {
          e.target.disabled = false;
          showError(err);
        }
      });
    }
  });
}
