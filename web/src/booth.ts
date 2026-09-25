/**
 * The dispatch booth (Art 4 rule cards; Art 5a slots, one-line editing, editor hand-off):
 * where the kata lives on the campus.
 *
 * The booth panel IS a constrained kata editor: four slot zones (`order, place, preempt,
 * route` — `scheduler_dojo.kata.ast.SLOTS` is ground truth), a card library (every module of
 * the reference-kata corpus), and one-line editing — each slotted card exposes its `key` /
 * first statement line as an input with the full card read-only beside it ("the card IS the
 * kata", Concepts/Tutorial.md). The arrangement serializes to a kata source — the text sent
 * to `check_kata` and `start({kata})` — and re-parsing that text reproduces the arrangement
 * (each filled slot prints as its module verbatim, `slot by name:` + indented body; empty
 * slots are absent). The reference katas in `levels/reference_katas/` are the card corpus.
 *
 * In a HAND run the bridge has no mid-run policy switch (`hand_start` runs the manual
 * policy), so a change here is *recorded*: persisted for the next kata run (`boothKata`
 * prefs, which `main.ts` boots kata mode from) and announced to the tutorial as the
 * `card_swapped` / `line_edited` / `booth_staffed` events. No invented engine behavior
 * lives here — the editor's truth is `bridge.checkKata` on the serialization.
 */

import { bridge, BridgeError } from "./bridge";
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

/** A rule card with its identity: the module label from its header (`shortest_first`). */
export interface BoothCard extends RuleCard {
  /** Stable corpus id: `${slot}:${name}`. */
  id: string;
  name: string;
}

/** What the booth is running: at most one card per slot; absent slots print as absent. */
export type BoothArrangement = Partial<Record<RuleSlot, BoothCard>>;

const HEADER = /^(order|place|preempt|route)\s+by\s+(\S+)\s*:/i;

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
    if (!trimmed || trimmed.startsWith("#")) continue;   // blanks/comments keep a module open
    if (current && /^\s/.test(line)) current.lines.push(trimmed);
    else current = null;                                 // a dedented line ends the module
  }
  return SLOTS.filter((slot) => cards.has(slot)).map((slot) => cards.get(slot)!);
}

/** The module label from a header line (`order by least_served_first:` -> the name). */
export function moduleName(header: string): string {
  return HEADER.exec(header)?.[2] ?? "custom";
}

export function isRuleSlot(value: string): value is RuleSlot {
  return (SLOTS as readonly string[]).includes(value);
}

/** DOM cards for a kata source, one per non-empty slot, in SLOTS order. */
export function boothCards(kataSource: string): BoothCard[] {
  return ruleCards(kataSource).map((card) => {
    const name = moduleName(card.header);
    return { ...card, name, id: `${card.slot}:${name}` };
  });
}

/** The booth state a kata source would serialize back to. */
export function arrangementFrom(kataSource: string): BoothArrangement {
  const arr: BoothArrangement = {};
  for (const card of boothCards(kataSource)) arr[card.slot] = card;
  return arr;
}

/**
 * The kata text the arrangement serializes to: filled slots print their module verbatim in
 * SLOTS order (empty slots are absent) — round-tripping this text back through `boothCards`
 * reproduces the arrangement (the engine's `slots()` is the ground truth for the shape).
 */
export function serializeBooth(arr: BoothArrangement): string {
  const parts: string[] = [];
  for (const slot of SLOTS) {
    const card = arr[slot];
    if (card) parts.push([card.header.trim(), ...card.lines.map((l) => `    ${l.trim()}`)].join("\n"));
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

/** The booth's display name for the current arrangement ("shortest_first + gap_fill"). */
export function boothName(arr: BoothArrangement): string {
  const names = SLOTS.map((slot) => arr[slot]?.name).filter((n): n is string => !!n);
  return names.length ? names.join(" + ") : "cards";
}

/** Every distinct module of the kata library, in library-then-SLOTS order (first wins). */
export async function loadBoothCorpus(): Promise<BoothCard[]> {
  const out: BoothCard[] = [];
  const seen = new Set<string>();
  for (const entry of KATA_LIBRARY) {            // sequential: the order is the contract
    const text = await loadKataText(entry);
    for (const card of boothCards(text)) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      out.push(card);
    }
  }
  return out;
}

/** The body line the one-line editor edits: the `key` line, else the first statement. */
export function editableLineIndex(card: RuleCard): number {
  const at = card.lines.findIndex((l) => l.startsWith("key"));
  return at >= 0 ? at : 0;
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

// --- shared dialog plumbing ---------------------------------------------------------------

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

function describeError(error: unknown): string {
  return error instanceof BridgeError ? `${error.code}: ${error.message}` : String(error);
}

// --- the booth dialog ---------------------------------------------------------------------

/** Debounce for the one-line editor's `check_kata` (ms of typing, not sim time). */
const EDIT_DEBOUNCE_MS = 350;

export interface BoothDialogOptions {
  /** Kata text the booth opens with (the staffed kata if there is one). */
  kataSource: string;
  staffed: boolean;
  /** `cards` focuses the slot picker; `line` focuses the one-line editor (`set_mode`). */
  mode?: "cards" | "line";
  /** Pulse target / focus slot for the `swap_card` / `edit_line` tutorial verbs. */
  focusSlot?: string;
  /** Focus the slot holding the card with this module name. */
  focusCard?: string;
  /** Every applied change (a slot commit or a line edit that passed `check_kata`). */
  onChange?: (kata: string, kind: "slot" | "edit") => void;
  /** "Open the full editor" — the kata mode prefilled with this serialization. */
  onOpenEditor?: (kata: string) => void;
}

export interface BoothDialogHandle {
  close(): void;
  /** Re-aim an already-open panel (tutorial `set_mode` / `swap_card` / `edit_line`). */
  showMode(opts: { mode?: "cards" | "line"; slot?: string; card?: string }): void;
  /** Pulse a slot zone (the `swap_card` picker nudge). */
  pulseSlot(slot: string): void;
}

/** The booth panel: four slot zones, the card library, the one-line editor, the editor link. */
export function openBoothDialog(options: BoothDialogOptions): BoothDialogHandle {
  let arr = arrangementFrom(options.kataSource);
  let pending: BoothCard | null = null;
  let corpus: BoothCard[] = [];
  let closed = false;
  let checkTimer = 0;

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
  const chip = document.createElement("span");          // PolicyError / check chip (Art 5)
  chip.className = "booth-chip";
  chip.setAttribute("role", "status");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "booth-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close the booth");
  head.append(title, state, chip, close);

  // --- slot zones --------------------------------------------------------------------
  const slotsHeading = document.createElement("h4");
  slotsHeading.textContent = "Card slots — these cards ARE the kata";
  const slotsBox = document.createElement("div");
  slotsBox.className = "booth-slots";
  const slotEls = new Map<RuleSlot, {
    zone: HTMLDivElement; button: HTMLButtonElement; cardLabel: HTMLElement;
    row?: HTMLDivElement; input?: HTMLInputElement; cardPre?: HTMLElement;
  }>();

  for (const slot of SLOTS) {
    const zone = document.createElement("div");
    zone.className = "booth-slot";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "booth-slot-btn";
    const nameEl = document.createElement("span");
    nameEl.className = "slot-name";
    nameEl.textContent = slot;
    const cardLabel = document.createElement("span");
    cardLabel.className = "slot-card";
    button.append(nameEl, cardLabel);
    button.addEventListener("click", () => tapSlot(slot));
    zone.append(button);
    slotsBox.append(zone);
    slotEls.set(slot, { zone, button, cardLabel });
  }

  /** The chip is engine truth: a plain open re-checks the serialization (announces nothing). */
  async function checkOnly(text: string): Promise<void> {
    try {
      const report = await bridge.checkKata(text);
      if (closed) return;
      if (report.ok) {
        chip.className = "booth-chip ok";
        chip.textContent = "kata ok";
      } else {
        paintError(report.errors[0]?.code ?? "kata", report.errors[0]?.message ?? "invalid");
      }
    } catch { /* a bridge that cannot answer leaves the chip silent, never wrong */ }
  }

  function renderSlot(slot: RuleSlot): void {
    const el = slotEls.get(slot)!;
    const card = arr[slot];
    el.cardLabel.textContent = card ? card.name : "empty — tap a card below";
    el.button.setAttribute("aria-label", card
      ? `${slot} slot: ${card.name} — tap to clear`
      : `${slot} slot: empty${pending?.slot === slot ? " — tap to place the selected card" : ""}`);
    // Rebuild the line row (input + full card) without disturbing a focused input.
    const focused = document.activeElement === el.input;
    el.row?.remove();
    el.row = undefined;
    el.input = undefined;
    el.cardPre = undefined;
    if (!card) return;
    const row = document.createElement("div");
    row.className = "booth-line";
    const input = document.createElement("input");
    input.className = "booth-line-input";
    input.type = "text";
    input.setAttribute("spellcheck", "false");
    input.value = card.lines[editableLineIndex(card)] ?? "";
    input.setAttribute("aria-label", `${slot} card — ${card.name} key line`);
    input.addEventListener("input", () => scheduleEdit(slot, input.value));
    const pre = document.createElement("pre");
    pre.className = "booth-card-src";
    pre.textContent = [card.header, ...card.lines].join("\n");
    row.append(input, pre);
    el.row = row;
    el.input = input;
    el.cardPre = pre;
    el.zone.append(row);
    if (focused) input.focus();
  }

  function renderSlots(): void {
    for (const slot of SLOTS) renderSlot(slot);
  }

  function paintHead(): void {
    const filled = SLOTS.filter((slot) => !!arr[slot]);
    state.textContent = options.staffed || filled.length
      ? `staffed — running "${boothName(arr)}"`
      : "empty — traffic by hand";
  }

  // --- card library (tap a card, then tap its slot) -------------------------------------
  const pickHeading = document.createElement("h4");
  pickHeading.textContent = "Cards";
  const picker = document.createElement("div");
  picker.className = "booth-library";
  const pickStatus = document.createElement("p");
  pickStatus.className = "booth-note";
  pickStatus.setAttribute("role", "status");
  pickStatus.textContent = "Loading the card rack…";
  const errorLine = document.createElement("div");
  errorLine.className = "booth-error";
  errorLine.setAttribute("role", "status");

  function renderPicker(): void {
    picker.replaceChildren(...corpus.map((card) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "booth-lib-card";
      const inUse = arr[card.slot]?.id === card.id;
      button.setAttribute("aria-pressed", String(inUse || pending?.id === card.id));
      const name = document.createElement("b");
      name.textContent = card.name;
      const slot = document.createElement("span");
      slot.textContent = card.slot;
      button.append(name, slot);
      button.title = inUse ? "in the slot now" : `tap, then tap the ${card.slot} slot`;
      button.addEventListener("click", () => {
        pending = pending?.id === card.id ? null : card;
        pickStatus.textContent = pending
          ? `${card.name} picked — now tap the ${card.slot} slot to put it in.`
          : "Card back on the rack.";
        renderPicker();
      });
      return button;
    }));
  }

  void loadBoothCorpus()
    .then((cards) => {
      if (closed) return;
      corpus = cards;
      pickStatus.textContent = pending
        ? pickStatus.textContent
        : "Tap a card, then tap its slot. Tap a filled slot to clear it.";
      renderPicker();
    })
    .catch((error: unknown) => {
      if (closed) return;
      errorLine.textContent = `cannot load the card rack: ${describeError(error)}`;
    });

  // --- the commit paths ---------------------------------------------------------------

  function tapSlot(slot: RuleSlot): void {
    if (pending) {
      if (pending.slot !== slot) {
        pickStatus.textContent = `${pending.name} is a ${pending.slot} card — its slot is ${pending.slot}.`;
        return;
      }
      arr = { ...arr, [slot]: pending };
      pending = null;
      pickStatus.textContent = `${arr[slot]!.name} now runs the ${slot} rule.`;
      commit("slot");
      return;
    }
    if (arr[slot]) {
      const cleared = arr[slot]!;
      arr = { ...arr };
      delete arr[slot];
      pickStatus.textContent = `${cleared.name} is off the ${slot} slot.`;
      commit("slot");
    }
  }

  function commit(kind: "slot" | "edit"): void {
    renderSlots();
    renderPicker();
    paintHead();
    void checkAndAnnounce(serializeBooth(arr), kind);
  }

  /** The serialization is the kata: every change is checked; only an ok check applies. */
  async function checkAndAnnounce(text: string, kind: "slot" | "edit"): Promise<void> {
    if (!text) {
      chip.className = "booth-chip";
      chip.textContent = "no cards";
      options.onChange?.(text, kind);
      return;
    }
    try {
      const report = await bridge.checkKata(text);
      if (closed) return;
      if (report.ok) {
        chip.className = "booth-chip ok";
        chip.textContent = "kata ok";
        options.onChange?.(text, kind);
      } else {
        paintError(report.errors[0]?.code ?? "kata", report.errors[0]?.message ?? "invalid");
      }
    } catch (error) {
      if (!closed) paintError("check", describeError(error));
    }
  }

  /** Red chip, engine code visible — the arrangement stays at the last valid text. */
  function paintError(code: string, message: string): void {
    chip.className = "booth-chip bad";
    chip.textContent = `${code}: ${message}`;
  }

  // --- the one-line editor (debounced check; invalid is never applied) ------------------

  function scheduleEdit(slot: RuleSlot, value: string): void {
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => void applyEdit(slot, value), EDIT_DEBOUNCE_MS);
  }

  async function applyEdit(slot: RuleSlot, value: string): Promise<void> {
    const card = arr[slot];
    if (!card || closed) return;
    const at = editableLineIndex(card);
    const draft: BoothCard = { ...card, lines: card.lines.map((l, i) => (i === at ? value : l)) };
    const text = serializeBooth({ ...arr, [slot]: draft });
    try {
      const report = await bridge.checkKata(text);
      if (closed) return;
      if (report.ok) {
        arr = { ...arr, [slot]: draft };
        const pre = slotEls.get(slot)!.cardPre;         // refresh the card beside the input
        if (pre) pre.textContent = [draft.header, ...draft.lines].join("\n");
        chip.className = "booth-chip ok";
        chip.textContent = "kata ok";
        options.onChange?.(text, "edit");
      } else {
        paintError(report.errors[0]?.code ?? "kata", report.errors[0]?.message ?? "invalid");
      }
    } catch (error) {
      if (!closed) paintError("check", describeError(error));
    }
  }

  // --- footer + assembly ----------------------------------------------------------------

  const note = document.createElement("p");
  note.className = "booth-note";
  note.textContent = "What is slotted here IS the kata the booth runs — the text below the "
    + "input is the whole card. Invalid lines get a red chip and are not applied.";
  const editorRow = document.createElement("div");
  editorRow.className = "booth-editor-row";
  const editorBtn = document.createElement("button");
  editorBtn.type = "button";
  editorBtn.textContent = "Open the full editor";
  editorBtn.addEventListener("click", () => {
    window.clearTimeout(checkTimer);
    handle.close();
    options.onOpenEditor?.(serializeBooth(arr));
  });
  editorRow.append(editorBtn);

  panel.append(head, slotsHeading, slotsBox, pickHeading, picker, pickStatus, note, errorLine,
    editorRow);
  overlay.append(panel);
  document.body.append(overlay);
  const previously = document.activeElement as HTMLElement | null;
  renderSlots();
  paintHead();
  if (serializeBooth(arr)) void checkOnly(serializeBooth(arr));
  applyMode({ mode: options.mode, slot: options.focusSlot, card: options.focusCard });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) handle.close();
  });
  close.addEventListener("click", () => handle.close());
  trapDialog(panel, () => handle.close());

  function applyMode(o: { mode?: "cards" | "line"; slot?: string; card?: string }): void {
    let slot: string | undefined = o.slot;
    if (!slot && o.card) {
      slot = SLOTS.find((s) => arr[s]?.name === o.card);
    }
    if (slot && isRuleSlot(slot)) pulseSlot(slot);
    if (o.mode === "line") {
      const target = slot && isRuleSlot(slot) ? slot
        : SLOTS.find((s) => !!arr[s]);
      const input = target ? slotEls.get(target)?.input : undefined;
      (input ?? close).focus();
    }
  }

  function pulseSlot(slot: string): void {
    if (!isRuleSlot(slot)) return;
    const zone = slotEls.get(slot)?.zone;
    if (!zone) return;
    zone.classList.remove("pulse");
    void zone.offsetWidth;                      // restart the pulse on a re-trigger
    zone.classList.add("pulse");
    window.setTimeout(() => zone.classList.remove("pulse"), 1300);
  }

  const handle = {
    close(): void {
      if (closed) return;
      closed = true;
      window.clearTimeout(checkTimer);
      overlay.remove();
      previously?.focus?.();
    },
    showMode(o: { mode?: "cards" | "line"; slot?: string; card?: string }): void {
      if (!closed) applyMode(o);
    },
    pulseSlot,
  };
  return handle;
}
