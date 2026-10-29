// Things you can do to a property from more than one place (card menu, drag and
// drop, the property sheet): move it, reject or restore it, delete it.
import { esc, REJECT_REASONS, stageLabel, title, announce, STAGES } from "./format.js";
import { store, moveTo, deleteProperty, updateProperty, upsertRow, inspectionsFor } from "./store.js";
import { openSheet, toast, showError, confirmDestructive } from "./ui.js";

export async function moveWithUndo(id, stage) {
  const p = store.properties.get(id);
  if (!p || p.stage === stage) return;
  if (stage === "rejected") return rejectFlow(id);
  const before = { stage: p.stage, position: p.position, rejected_reason: p.rejected_reason, rejected_note: p.rejected_note, rejected_from_stage: p.rejected_from_stage };
  try {
    await moveTo(id, stage);
    announce(`Moved to ${stageLabel(stage)}`);
    toast(`Moved to ${stageLabel(stage)}`, { undo: () => updateProperty(id, before).catch(showError) });
  } catch (err) {
    showError(err, "Couldn't move the card");
  }
}

export function moveMenuItems(p, after) {
  return STAGES.map((s) => ({
    label: s.label,
    current: p.stage === s.id,
    onClick: async () => { await moveWithUndo(p.id, s.id); after?.(); }
  }));
}

export function rejectFlow(id, { onDone } = {}) {
  const p = store.properties.get(id);
  if (!p) return;
  let reason = null;
  let sheet = null;
  openSheet({
    title: "Reject",
    label: `Reject ${title(p)}`,
    fit: true,
    left: { label: "Cancel" },
    right: {
      label: "Reject",
      bold: true,
      disabled: true,
      onClick: async () => {
        const note = sheet.body.querySelector("#reject-note").value.trim() || null;
        const before = { stage: p.stage, position: p.position, rejected_reason: p.rejected_reason, rejected_note: p.rejected_note, rejected_from_stage: p.rejected_from_stage };
        try {
          await moveTo(id, "rejected", { rejected_reason: reason, rejected_note: note, rejected_from_stage: p.stage });
          sheet.close();
          announce("Rejected");
          toast("Moved to Rejected", { undo: () => updateProperty(id, before).catch(showError) });
          onDone?.();
        } catch (err) {
          showError(err, "Couldn't reject the card");
        }
      }
    },
    render(body, s) {
      sheet = s;
      body.innerHTML = `
        <p class="group-footer" style="margin-top:4px">${esc(title(p))}</p>
        <div class="group-header" id="reason-label">Why?</div>
        <div class="chips" role="group" aria-labelledby="reason-label">
          ${REJECT_REASONS.map((r) => `<button type="button" class="chip" aria-pressed="false" data-reason="${r.id}">${esc(r.label)}</button>`).join("")}
        </div>
        <div class="group-header"><label for="reject-note">Note (optional)</label></div>
        <div class="group"><div class="form-row stacked"><textarea id="reject-note" rows="3" placeholder="Anything to remember about it"></textarea></div></div>
        <p class="group-footer">You can restore it from Rejected at any time.</p>`;
      body.querySelectorAll("[data-reason]").forEach((chip) => chip.addEventListener("click", () => {
        reason = chip.dataset.reason;
        body.querySelectorAll("[data-reason]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
        sheet.setRightDisabled(false);
      }));
    }
  });
}

export async function restore(id) {
  const p = store.properties.get(id);
  if (!p) return;
  const to = p.rejected_from_stage && p.rejected_from_stage !== "rejected" ? p.rejected_from_stage : "saved";
  await moveWithUndo(id, to);
}

export async function deleteFlow(id) {
  const p = store.properties.get(id);
  if (!p) return false;
  const ok = await confirmDestructive(`Delete ${title(p)}?`, "Its comments and checklist go too. This can't be undone. To keep it but take it off the board, reject it instead.");
  if (!ok) return false;
  try {
    await deleteProperty(id);
    announce("Deleted");
    toast("Deleted");
    return true;
  } catch (err) {
    showError(err, "Couldn't delete it");
    return false;
  }
}

export function openListing(p) {
  const url = p.sources?.[0]?.url;
  if (url) window.open(url, "_blank", "noopener");
}

// Marking an inspection booked moves a Saved card to "Inspection booked".
export async function setBooked(inspection, booked) {
  try {
    await upsertRow("inspection_times", { id: inspection.id, booked });
    const p = store.properties.get(inspection.property_id);
    if (booked && p?.stage === "saved") {
      await moveWithUndo(p.id, "inspection_booked");
    } else {
      toast(booked ? "Inspection booked — we'll remind you" : "Inspection unbooked");
    }
  } catch (err) {
    showError(err, "Couldn't update the inspection");
  }
}

export function bookableInspection(propertyId) {
  const now = Date.now();
  return inspectionsFor(propertyId).find((i) => !i.booked && new Date(i.starts_at).getTime() > now) ?? null;
}
