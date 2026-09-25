/**
 * The dispatch booth (Art 4): where the kata lives on the campus. A rule card IS a kata module —
 * the card list is produced by splitting a kata source into its `SLOTS` modules (no parsing
 * beyond line splitting; the kata source is the card, see Concepts/Tutorial.md "cards are katas").
 *
 * "Staff the booth" during a hand run records the choice: the bridge has no mid-run policy
 * switch (`hand_start` runs the manual policy), so staffing satisfies the tutorial's
 * `booth_staffed` predicate and is persisted so the next kata-mode run preselects it. That is
 * the whole automation story until the booth itself lands in kata mode (Art 5) — no invented
 * engine behavior lives here.
 */

import { loadKataText, KATA_LIBRARY } from "./library";
import { load as loadStore, save as saveStore } from "./persistence";

/** Kata module slots, in canonical order (mirrors `scheduler_dojo.kata.ast.SLOTS`). */
export const SLOTS = ["order", "place", "preempt", "route"] as const;
export type RuleSlot = (typeof SLOTS)[number];

export interface RuleCard {
  slot: RuleSlot;
  /** The module header line, verbatim (`order by fifo_like:`). */
  header: string;
  /** The module body lines, verbatim, indentation trimmed. */
  lines: string[];
}

const HEADER = /^(order|place|preempt|route)\s+by\s+\S+\s*:/i;

/** Split a kata source into its non-empty modules, ordered by SLOTS (a later module wins). */
export function ruleCards(kataSource: string): RuleCard[] {
  const cards = new Map<RuleSlot, RuleCard>();
  let current: RuleCard | null = null;
  for (const line of (kataSource ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = HEADER.exec(trimmed);
    if (header) {
      current = { slot: header[1]!.toLowerCase() as RuleSlot, header: trimmed, lines: [] };
      cards.set(current.slot, current);
      continue;
    }
    if (!trimmed) continue;               // blank lines keep a module open
    if (current && /^\s/.test(line)) current.lines.push(trimmed);
    else current = null;                  // a dedented non-header line ends the module
  }
  return SLOTS.filter((slot) => cards.has(slot)).map((slot) => cards.get(slot)!);
}

/** DOM cards for a kata source, one per non-empty slot, in SLOTS order. */
export function renderRuleCards(kataSource: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "rule-cards";
  for (const card of ruleCards(kataSource)) {
    const el = document.createElement("div");
    el.className = "rule-card";
    const name = document.createElement("h4");
    name.textContent = card.slot;
    const src = document.createElement("pre");
    src.className = "rule-card-src";
    src.textContent = [card.header, ...card.lines].join("\n");
    el.append(name, src);
    box.append(el);
  }
  if (!box.children.length) {
    const empty = document.createElement("p");
    empty.className = "rule-cards-empty";
    empty.textContent = "No rules on the board yet — staff the booth to put one in.";
    box.append(empty);
  }
  return box;
}

// --- the booth-staffing record (localStorage prefs; the engine never sees it) -------------

export interface BoothChoice {
  name: string;
  text: string;
}

/** Remember the booth's kata (name + text) for the next kata run's preselect. */
export function saveBoothChoice(name: string, text: string): void {
  saveStore({ prefs: { boothKata: name, boothKataText: text } });
}

export function getBoothChoice(): BoothChoice | null {
  const prefs = loadStore().prefs as Record<string, unknown>;
  const name = prefs.boothKata;
  const text = prefs.boothKataText;
  return typeof name === "string" && typeof text === "string" ? { name, text } : null;
}

// --- the booth dialog ---------------------------------------------------------------------

/** Shared modal-dialog keyboard plumbing (Concepts/Accessibility rule 5): Escape closes and Tab
 *  stays inside the panel. Openers own focus move-in and focus restore. */
export function trapDialog(panel: HTMLElement, onClose: () => void): void {
  panel.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...panel.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input, select")];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

export interface BoothDialogOptions {
  /** Kata text whose modules show as the current rule cards (the staffed kata if there is one). */
  kataSource: string;
  staffed: boolean;
  staffedName?: string | null;
  /** Called with (library entry name, kata text) when the player staffs the booth. */
  onStaff: (name: string, kataText: string) => void;
}

/** The booth panel: rule cards + "Staff the booth" (pick one reference kata from the library). */
export function openBoothDialog(options: BoothDialogOptions): { close(): void } {
  const overlay = document.createElement("div");
  overlay.className = "booth-overlay";
  const panel = document.createElement("section");
  panel.className = "booth-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "booth-dialog-title");

  const head = document.createElement("div");
  head.className = "booth-head";
  const title = document.createElement("h3");
  title.id = "booth-dialog-title";
  title.textContent = "Dispatch booth";
  const state = document.createElement("span");
  state.className = "booth-state";
  state.setAttribute("role", "status");
  state.textContent = options.staffed
    ? `staffed — running "${options.staffedName ?? "your card"}"`
    : "empty — traffic by hand";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "booth-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close the booth");
  head.append(title, state, close);

  const cardsHeading = document.createElement("h4");
  cardsHeading.textContent = "Rule cards (the kata, as the booth sees it)";
  const cards = renderRuleCards(options.kataSource);

  const staffHeading = document.createElement("h4");
  staffHeading.textContent = "Staff the booth — pick one card";
  const staffBox = document.createElement("div");
  staffBox.className = "booth-staff";
  const note = document.createElement("p");
  note.className = "booth-note";
  note.textContent = "In hand traffic a card records your rule for the road (the booth takes over "
    + "for real when you run katas); it also starts your next kata run preselected.";
  const errorLine = document.createElement("div");
  errorLine.className = "booth-error";
  errorLine.setAttribute("role", "status");
  for (const entry of KATA_LIBRARY) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "booth-staff-card";
    const name = document.createElement("b");
    name.textContent = entry.name;
    const blurb = document.createElement("span");
    blurb.textContent = entry.blurb;
    card.append(name, blurb);
    card.addEventListener("click", () => {
      void loadKataText(entry)
        .then((text) => {
          handle.close();
          options.onStaff(entry.name, text);
        })
        .catch((error: unknown) => {
          errorLine.textContent = `cannot load ${entry.name}: ${String(error)}`;
        });
    });
    staffBox.append(card);
  }

  panel.append(head, cardsHeading, cards, staffHeading, staffBox, note, errorLine);
  overlay.append(panel);
  document.body.append(overlay);
  const previously = document.activeElement as HTMLElement | null;
  close.focus();
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) handle.close();
  });
  close.addEventListener("click", () => handle.close());
  trapDialog(panel, () => handle.close());

  const handle = {
    close(): void {
      overlay.remove();
      previously?.focus?.();
    },
  };
  return handle;
}
