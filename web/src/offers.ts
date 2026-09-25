/**
 * The ONE offers overlay (Art 6): the week-end choice, rendered in both the live/hand campus
 * week-end freeze (`campus-play.ts`) and the tutorial's `offer_upgrade {pick_of: 2}` beat
 * (`tutorial.ts`). Offers arrive as *buildings you can inspect* — name + blurb + what it unlocks,
 * all from `progression_view` metadata (the engine's `BUILDINGS` table; one fact, one place).
 *
 * The component decides nothing: `onTake` is the caller's bridge call (`offer_accept` — the free
 * week-end grant), and its `{ok, message}` verdict is echoed into the live note. "Later" closes
 * the panel and leaves the week unresolved; the offers are a deterministic function of
 * (save, city, week), so the same pair appears next time the panel opens.
 */

import { trapDialog } from "./booth";

export interface OfferCard {
  id: string;
  name: string;
  blurb: string;
  /** what it unlocks, in one short line (from `progression_view.upgrades[id].unlocks`) */
  unlocks: string;
}

export interface OfferVerdict {
  ok: boolean;
  message: string;
}

export interface OffersPanelOptions {
  /** the campus stage the panel anchors to (same host as callouts) */
  host: HTMLElement;
  title: string;
  cards: OfferCard[];
  /** true adds the "Later" button (closes the panel; the week stays unresolved) */
  later?: boolean;
  /** the caller's grant: `offer_accept` (free) — never a credit purchase */
  onTake: (id: string) => Promise<OfferVerdict>;
  /** called once when the panel is dismissed (take or Later) */
  onDismiss?: () => void;
}

export interface OffersPanelHandle {
  close(): void;
  isOpen(): boolean;
}

export function openOffersPanel(opts: OffersPanelOptions): OffersPanelHandle {
  const overlay = document.createElement("div");
  overlay.className = "callout-overlay";
  const panel = document.createElement("section");
  panel.className = "callout-panel offers-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "offers-panel-title");
  const title = document.createElement("h3");
  title.id = "offers-panel-title";
  title.textContent = opts.title;
  const list = document.createElement("div");
  list.className = "offers-list";
  const note = document.createElement("div");
  note.className = "offers-note";
  note.setAttribute("role", "status");
  panel.append(title, list, note);
  overlay.append(panel);
  opts.host.append(overlay);

  const takeButtons: HTMLButtonElement[] = [];
  for (const card of opts.cards) {
    const el = document.createElement("div");
    el.className = "offer-card";
    const text = document.createElement("div");
    text.className = "offer-text";
    const name = document.createElement("b");
    name.textContent = card.name;
    const blurb = document.createElement("span");
    blurb.className = "offer-blurb";
    blurb.textContent = card.blurb;
    const unlocks = document.createElement("span");
    unlocks.className = "offer-unlocks";
    unlocks.textContent = card.unlocks;
    text.append(name, blurb, unlocks);
    const take = document.createElement("button");
    take.type = "button";
    take.textContent = "Take";
    take.addEventListener("click", () => {
      take.disabled = true;
      void opts.onTake(card.id).then((verdict) => {
        note.textContent = verdict.message;
        if (verdict.ok) dismiss();
        else take.disabled = false;   // refused (not offered / already taken) — try the other
      });
    });
    takeButtons.push(take);
    el.append(text, take);
    list.append(el);
  }
  if (!opts.cards.length) {
    const none = document.createElement("p");
    none.textContent = "This week has no new buildings to offer — the campus already has them all.";
    list.append(none);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = opts.later ? "Later" : "Done";
  close.addEventListener("click", () => dismiss());
  const actions = document.createElement("div");
  actions.className = "callout-actions";
  actions.append(close);
  panel.append(actions);

  const previously = document.activeElement as HTMLElement | null;
  (takeButtons[0] ?? close).focus();
  trapDialog(panel, () => dismiss());
  let open = true;
  const dismiss = (): void => {
    if (!open) return;
    open = false;
    overlay.remove();
    previously?.focus?.();
    opts.onDismiss?.();
  };
  return { close: dismiss, isOpen: () => open };
}
