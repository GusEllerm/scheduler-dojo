/**
 * The help drawer (Art 8, brief §9 "help drawer"). One panel that answers the three questions a
 * player arrives with — *how do I read this picture*, *what do the buttons do*, *which keys work*
 * — built entirely from constants and the shared token table (`tokens.ts`): **no engine call
 * happens in here**, so it opens instantly and cannot disagree with a running simulation.
 *
 * The honesty contract: the shortcut table shown here is the SAME array `main.ts` registers its
 * global key handler from (`SHORTCUTS`), so the drawer cannot promise a key that does not exist
 * — and `web/scripts/art8_a11y.mjs` presses every key the table lists and asserts its effect
 * ([[Accessibility]] rule 13). Focus-trapped by the shared `trapDialog` like every dialog here.
 */

import { trapDialog } from "./booth";
import { readTokens } from "./tokens";

/** [key, promise] — `main.ts` implements exactly these; the audit presses them. */
export const SHORTCUTS: [string, string][] = [
  ["?", "open or close this help"],
  ["Esc", "close the topmost card (help, offers, review, board, callouts, cards)"],
  ["Space", "pause / resume the campus clock — live campus play (the hand campus waits for "
    + "taps and the arrow keys, so Space does nothing there)"],
  ["S", "Step \u25b8 — one event batch, the clock stays paused (live campus)"],
  ["1 / 2 / 3", "playback speed 1x / 2x / 4x (live campus — the speed select keeps working)"],
];

/** One line per top-level mode (the picker's four buttons; `main.ts` titles them from here). */
export const MODE_NOTES: [string, string][] = [
  ["Campus (live)", "watch the city run itself under a policy — pause, Step \u25b8, and speed "
    + "are yours"],
  ["Watch (auto)", "a finished run as a timeline strip, replayable and scrubbable"],
  ["Play by hand", "you park every vehicle on the strip\u2019s levels (1\u20132)"],
  ["Write a kata", "write the policy yourself and run it against the level"],
];

/** [token role, what it is] — the scene vocabulary of [[Campus]]'s mapping table, one line each. */
const READ_ROWS: [string, string][] = [
  ["veh-queued", "a vehicle on the road \u2014 a queued job (width = bays asked, length = the "
    + "walltime it claimed)"],
  ["veh-running", "a parked vehicle \u2014 running in its bays"],
  ["veh-done", "served \u2014 done"],
  ["veh-timeout", "timed out \u2014 waited past its patience"],
  ["bay-default", "a bay is one machine; lots are rooms of bays (their material = the partition)"],
  ["bay-wasted", "a dark bay while vehicles wait \u2014 wasted capacity"],
  ["nb-1", "a neighbourhood \u2014 one person\u2019s jobs; the ring around it is their patience"],
  ["warn", "a \u25c6 starved neighbour \u2014 served under half its share"],
  ["overflow", "an overflowed ring ends the run"],
];

let current: { close(): void } | null = null;

export function isHelpOpen(): boolean {
  return current !== null;
}

export function closeHelp(): void {
  current?.close();
}

/** The header "?" button (Art 8): the drawer is reachable from every mode, not only the campus. */
export function mountHelpButton(host: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "help-button";
  button.textContent = "?";
  button.setAttribute("aria-label", "Help");
  button.setAttribute("aria-haspopup", "dialog");
  button.title = "help: how to read the campus, the controls, the keys";
  button.addEventListener("click", () => toggleHelp());
  host.append(button);
  return button;
}

export function toggleHelp(host: HTMLElement = document.body): void {
  if (current) current.close();
  else void openHelp(host);
}

/** One drawer at a time; opening replaces (a re-click of "?" while focused toggles). */
export function openHelp(host: HTMLElement = document.body): { close(): void } {
  closeHelp();
  const overlay = document.createElement("div");
  overlay.className = "review-overlay help-overlay";
  const panel = document.createElement("section");
  panel.className = "callout-panel help-drawer";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "help-title");
  overlay.append(panel);
  host.append(overlay);

  const title = document.createElement("h3");
  title.id = "help-title";
  title.textContent = "Help";
  panel.append(title);

  const tokens = readTokens();
  const readHead = heading("How to read the campus");
  const readList = document.createElement("ul");
  readList.className = "help-read";
  for (const [role, text] of READ_ROWS) {
    const li = document.createElement("li");
    const swatch = document.createElement("i");
    swatch.className = "help-swatch";
    swatch.style.background = tokens[role] ?? "";
    swatch.setAttribute("aria-hidden", "true");
    const span = document.createElement("span");
    span.textContent = text;
    li.append(swatch, span);
    readList.append(li);
  }
  const readNote = document.createElement("p");
  readNote.className = "help-note";
  readNote.textContent = "The road is the queue, the buildings are the upgrades you own "
    + "(hover or tap one for its name), and everything the picture says in colour, the rail and "
    + "the scorecards also say in words.";
  panel.append(readHead, readList, readNote);

  panel.append(heading("Controls"));
  panel.append(paragraph(
    "Pause / Resume stops the clock; Step \u25b8 takes the clock from the rAF loop \u2014 one event "
    + "batch per press, and the why-panel keeps step; the speed select (or 1/2/3) is the pace of "
    + "watching only \u2014 the simulation is the same either way. On the hand campus: tap a "
    + "vehicle, tap bays, Park it \u2014 or focus the canvas and use arrows + Enter."));

  panel.append(heading("The four modes"));
  const modes = document.createElement("ul");
  for (const [name, text] of MODE_NOTES) {
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = `${name} — `;
    li.append(b, document.createTextNode(text));
    modes.append(li);
  }
  panel.append(modes);

  panel.append(heading("Keyboard"));
  const table = document.createElement("table");
  table.className = "help-keys";
  for (const [key, promise] of SHORTCUTS) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    th.append(kbd);
    const td = document.createElement("td");
    td.textContent = promise;
    tr.append(th, td);
    table.append(tr);
  }
  panel.append(table);
  panel.append(paragraph(
    "Reduced motion: with your system set to reduce motion, nothing animates at all — the campus "
    + "redraws when the simulation says something instead of every frame, and the timeline waits "
    + "for an explicit Play."));

  const actions = document.createElement("div");
  actions.className = "callout-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  actions.append(close);
  panel.append(actions);

  const previously = document.activeElement as HTMLElement | null;
  let open = true;
  const dismiss = (): void => {
    if (!open) return;
    open = false;
    overlay.remove();
    if (current === handle) current = null;
    previously?.focus?.();
  };
  const handle = { close: dismiss };
  current = handle;
  close.addEventListener("click", () => dismiss());
  close.focus();
  trapDialog(panel, dismiss);
  return handle;
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h4");
  h.textContent = text;
  return h;
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}
