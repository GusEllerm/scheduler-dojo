/**
 * The city board (Art 7b, brief §7: "nine city tiles with a live thumbnail of the campus, best
 * score, belt marks, locks; endless with its best"). One overlay, ten tiles, nothing decided:
 *
 * - **The thumbnail is a real engine frame** (`campus-thumb.ts`): the city *edition* (the same
 *   level dict the tutorial system loads) stepped to 30 % of its week under a named policy and
 *   painted by the campus renderer into the tile's canvas. Cached per page session. A tile still
 *   drawing says "drawing…" — never a fake campus.
 * - **The frame colour is this level's verdict on the player's best score** ([agent decision],
 *   Art 7b): gold bar earned ⇒ `gold`, pass bar earned ⇒ `ok` (the palette's *pass* role), played
 *   below pass ⇒ `warn`, never played ⇒ dim. The mapping is the level file's `bars`, NOT the
 *   lifetime belt — a belt is credits across every level ([[Progression]]) and says nothing about
 *   this city. Every frame colour is repeated in a text label, so colour never carries the meaning
 *   alone ([[Accessibility]]).
 * - **Locks are the owned frontier**: a city is unlocked when its level has at least one recorded
 *   pass, or when it IS the frontier (the first city never completed). A locked tile stays a
 *   focusable button that answers with the way out instead of doing nothing.
 * - **Endless** shows the save's best (days / served) and starts the growing city. It has **no
 *   share button**: a 30-day materialized stream does not fit a URL-sized card, and the tile says
 *   so ([[Concepts/Campus]] — the limitation is stated, not hidden).
 */

import { bridge, type BuildingInfo, type Level } from "./bridge";
import { trapDialog } from "./booth";
import { cityLevel } from "./tutorial";
import { getProgression } from "./progression";
import { levelProgress } from "./persistence";
import { paintCampusThumbnail, THUMB_H, THUMB_W, type ThumbRequest } from "./campus-thumb";

/** Cities on the board (§2.5: nine cities, then endless). */
export const BOARD_CITIES = 9;

export interface BoardEndless {
  unlocked: boolean;
  best: { days: number; served: number } | null;
  seed: number;
  /** the seeded endless level dict, built on demand for the tile's thumbnail */
  level: (seed: number) => Promise<Level>;
}

export interface BoardOptions {
  /** overlay host (defaults to document.body) */
  host?: HTMLElement;
  /** start city N — the shell applies the Art 6b chaining rules (script + hand traffic) */
  onStartCity: (city: number) => void;
  /** start the endless city (the shell owns the seed and the chip state) */
  onStartEndless: () => void;
  endless?: BoardEndless;
  onClose?: () => void;
}

export interface BoardHandle {
  close(): void;
}

/** The verdict a best score earns its tile's frame (the level's own `bars`, not the lifetime belt). */
export type TileVerdict = "gold" | "pass" | "below" | "none";

export function tileVerdict(played: boolean, best: number,
                            bars?: { pass_score?: number; gold_score?: number }): TileVerdict {
  if (!played) return "none";
  if (best >= Number(bars?.gold_score ?? 720)) return "gold";
  if (best >= Number(bars?.pass_score ?? 350)) return "pass";
  return "below";
}

const VERDICT_LABEL: Record<TileVerdict, string> = {
  gold: "gold bar", pass: "pass bar", below: "below pass", none: "not played",
};

let current: BoardHandle | null = null;

/** Close any open board (mode switches use it, as they do for the review panel). */
export function closeCityBoard(): void {
  current?.close();
}

/** One save-derived fact per city level: the best score, and whether any run completed it. */
export function cityFacts(levelId: string): { best: number; played: boolean } {
  const state = getProgression()?.levels?.[levelId];
  const legacy = levelProgress(levelId);
  const best = Math.max(Number(state?.best ?? 0), Number(legacy.best ?? 0));
  const played = (state?.passes?.length ?? 0) > 0 || (legacy.completed?.length ?? 0) > 0;
  return { best, played };
}

/** The frontier city: the first never-completed city (all complete ⇒ the last one). */
export function frontierCity(played: (levelId: string) => boolean): number {
  for (let city = 1; city <= BOARD_CITIES; city++) {
    if (!played(`level${city}`)) return city;
  }
  return BOARD_CITIES;
}

export function openCityBoard(opts: BoardOptions): BoardHandle {
  current?.close();
  const overlay = document.createElement("div");
  overlay.className = "board-overlay";
  const panel = document.createElement("section");
  panel.className = "callout-panel campus-board";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "board-title");
  overlay.append(panel);
  (opts.host ?? document.body).append(overlay);

  const title = document.createElement("h3");
  title.id = "board-title";
  title.textContent = "City board";
  const note = document.createElement("p");
  note.className = "board-note";
  note.textContent = "Each tile is that city's own campus at 30% of its week — a real engine "
    + "frame, not a picture of one. The frame colour is this save's best score against this city's "
    + "own pass and gold bars.";
  const status = document.createElement("p");
  status.className = "board-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(title, note, status);

  const grid = document.createElement("div");
  grid.className = "board-grid";
  grid.setAttribute("role", "list");
  panel.append(grid);

  const actions = document.createElement("div");
  actions.className = "callout-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Back to the campus";
  actions.append(close);
  panel.append(actions);

  const handle: BoardHandle = { close: () => dismiss() };
  let open = true;
  const previously = document.activeElement as HTMLElement | null;
  const frontier = frontierCity((id) => cityFacts(id).played);

  for (let city = 1; city <= BOARD_CITIES; city++) cityTile(grid, status, city, frontier, opts);
  if (opts.endless) endlessTile(grid, status, opts);

  close.addEventListener("click", () => dismiss());
  close.focus();
  trapDialog(panel, () => dismiss());
  current = handle;
  return handle;

  function dismiss(): void {
    if (!open) return;
    open = false;
    overlay.remove();
    if (current === handle) current = null;
    previously?.focus?.();
    opts.onClose?.();
  }
}

/** Paint one tile's thumbnail, reporting failure as text instead of drawing a lie. */
async function drawThumb(canvas: HTMLCanvasElement, req: ThumbRequest,
                        pending: HTMLElement): Promise<void> {
  try {
    await paintCampusThumbnail(canvas, req);
    pending.hidden = true;
  } catch (error) {
    canvas.hidden = true;
    pending.textContent = `thumbnail failed: ${error instanceof Error ? error.message : error}`;
  }
}

function cityTile(grid: HTMLElement, status: HTMLElement, city: number, frontier: number,
                  opts: BoardOptions): void {
  const levelId = `level${city}`;
  const facts = cityFacts(levelId);
  const locked = !facts.played && city !== frontier;
  const button = tileShell(grid, `City ${city}`, String(city));
  const { thumb, pending, best } = tileParts(button);
  best.textContent = facts.played ? `best ${facts.best} · completed \u2713` : "no run recorded";

  const speak = (verdict: TileVerdict): string => `City ${city}. ${VERDICT_LABEL[verdict]}. `
    + (locked ? `Locked — finish city ${frontier} first.`
      : facts.played ? "Completed. Tap to play it." : "Tap to play it.");
  button.setAttribute("aria-label", speak("none"));
  button.title = locked
    ? `locked — city ${frontier} is the next city to complete`
    : "start this city (its tutorial script rides along, as in the chain)";
  if (!facts.played) button.classList.add("frame-none");
  button.addEventListener("click", () => {
    if (locked) {
      status.textContent = `City ${city} is locked — it unlocks when you complete city ${frontier}, `
        + `the next city in the chain.`;
      return;
    }
    opts.onStartCity(city);
    current?.close();
  });

  // The frame verdict needs this city's own bars, which live in the level file; the city edition
  // fetch is the one the thumbnail needs too, so one request feeds both.
  void (async (): Promise<void> => {
    const level = await cityLevel(`city${city}`).then((r) => r?.level ?? null).catch(() => null);
    if (!level) {
      thumb.hidden = true;
      pending.textContent = "city level unavailable";
      return;
    }
    const verdict = tileVerdict(facts.played, facts.best,
                                level.bars as { pass_score?: number; gold_score?: number } | undefined);
    button.classList.add(`frame-${verdict}`);
    setVerdict(button, verdict, locked);
    button.setAttribute("aria-label", speak(verdict));
    await drawThumb(thumb, { level, policy: "fifo", buildings: await ownedBuildings() }, pending);
  })().catch(() => undefined);
}

function endlessTile(grid: HTMLElement, status: HTMLElement, opts: BoardOptions): void {
  const e = opts.endless;
  if (!e) return;
  const button = tileShell(grid, "Endless", "endless");
  const { thumb, pending, best } = tileParts(button);
  button.classList.add("board-endless");
  best.textContent = e.best ? `best ${e.best.days} days · ${e.best.served} served` : "no run recorded";
  const note = document.createElement("span");
  note.className = "board-tile-note";
  note.textContent = `seed ${e.seed} · one street, growing until a ring overflows · no share card `
    + "(the stream is not URL-sized)";
  button.append(note);
  pending.textContent = e.unlocked ? "drawing…" : "locked — unlocks after city 3";
  button.title = e.unlocked ? "the growing city at this save's seed" : "unlocked after city 3";
  button.setAttribute("aria-label", `Endless. ${e.unlocked
    ? `Seed ${e.seed}. ${e.best ? `Best ${e.best.days} days, ${e.best.served} served.` : "No run recorded."}
      Tap to play it. No share card.`
    : "Locked — finish city 3 first."}`);

  button.addEventListener("click", () => {
    if (!e.unlocked) {
      status.textContent = "Endless is locked — finish city 3 and the campaign turns it on.";
      return;
    }
    opts.onStartEndless();
    current?.close();
  });
  void (async (): Promise<void> => {
    if (!e.unlocked) {
      thumb.hidden = true;
      return;
    }
    await drawThumb(thumb, { level: await e.level(e.seed), policy: "shortest_first",
                             buildings: await ownedBuildings() }, pending);
  })().catch((error: unknown) => {
    pending.textContent = `thumbnail failed: ${error instanceof Error ? error.message : error}`;
  });
}

/* ------------------------------------------------------------------ tiles -- */

function tileShell(grid: HTMLElement, label: string, cityKey: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "board-tile";
  button.setAttribute("role", "listitem");
  button.dataset.city = cityKey;
  const name = document.createElement("b");
  name.className = "board-tile-name";
  name.textContent = label;
  const verdict = document.createElement("span");
  verdict.className = "board-verdict";
  button.append(name, verdict);
  grid.append(button);
  return button;
}

/** The canvas + its honest "drawing…" note, inserted BEFORE the name so the tile reads top-down. */
function tileParts(button: HTMLButtonElement): { thumb: HTMLCanvasElement; pending: HTMLElement;
                                                 best: HTMLElement } {
  const thumb = document.createElement("canvas");
  thumb.className = "board-thumb";
  thumb.style.aspectRatio = `${THUMB_W} / ${THUMB_H}`;
  thumb.setAttribute("aria-hidden", "true");   // the tile's text lines say everything it shows
  const pending = document.createElement("span");
  pending.className = "board-pending";
  pending.textContent = "drawing…";
  const best = document.createElement("span");
  best.className = "board-best hash";
  const name = button.querySelector(".board-tile-name") as HTMLElement;
  button.insertBefore(thumb, name);
  button.insertBefore(pending, name);
  button.append(best);
  return { thumb, pending, best };
}

function setVerdict(button: HTMLElement, verdict: TileVerdict, locked: boolean): void {
  const el = button.querySelector(".board-verdict");
  if (el) el.textContent = VERDICT_LABEL[verdict] + (locked ? " · \ud83d\udd12 locked" : "");
}

/** Owned upgrades as campus sprites — the same table the live campus paints (cached per session). */
let buildings: BuildingInfo[] | null = null;
function ownedBuildings(): Promise<BuildingInfo[]> {
  buildings ??= bridge.progressionView(getProgression())
    .then((view) => view.buildings ?? [])
    .catch(() => [] as BuildingInfo[]);
  return buildings;
}
