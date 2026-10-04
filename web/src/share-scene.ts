/**
 * Share cards in the campus art (Art 7b, brief §5.8 / §7: "share card in the new art with a campus
 * thumbnail and the verification badge"). Two halves:
 *
 * **Mint** (`openCampusShareDialog`, from the review screen's "Share this run"): one engine call —
 * `share_encode(level, seed, policy|kata)` runs the level and embeds the run's `trajectory_hash` —
 * then a card element: a compact text card plus a **campus thumbnail** drawn into the card by the
 * same painter the board uses, at a photogenic sim time of this run (`campus-thumb.ts`). The link is
 * `<origin><pathname>#card=<base64url body>` — a **hash**, so GitHub Pages serves it with no server
 * and no rewrite (phase one's `?c=` needed the query; a hash needs nothing).
 *
 * **View** (`openShareCardView`, at boot when the URL carries `#card=`): decode client-side for the
 * metadata, resolve the level, then let the engine decide — `share_replay` re-runs and compares
 * hashes. `ok` ⇒ a "verified replay" badge; anything else ⇒ a tampered banner. Either way the card
 * says which hash it promised and which it got, and the run opens in watch mode.
 *
 * [agent decision] **The envelope is unchanged** (`CARD_VERSION` 1, `share/card.py` untouched): a
 * city run rides it by embedding the *city edition* level dict, because `encode_card` embeds
 * `duration`/`generator`/`unlocks`/… from the dict it is given. Old phase-one cards therefore still
 * verify. Two honest edges: (1) a level whose jobs are an explicit list (level7/8) cannot carry them
 * in a URL-sized card, so on replay the **shipped level dict is merged UNDER the card's embedded
 * fields** — jobs from the file, every fact the card asserts from the card; (2) **endless runs are
 * not shareable**: the stream is materialized (a 30-day horizon, thousands of jobs) and no card can
 * hold it, so the endless tile and endless review offer no share button at all.
 */

import { bridge, BridgeError, type Level, type RunResult } from "./bridge";
import { cardLevelId, decodeShareCard, encodableLevel, type DecodedShareCard } from "./share";
import { paintCampusThumbnail, type ThumbRequest } from "./campus-thumb";
import { ownedBuildings } from "./board";
import { formatTime } from "./render/timeline";

/** Everything the card needs about one finished run. */
export interface CampusShareContext {
  level: Level;
  levelId: string;
  title: string;
  seed: number;
  /** The policy the CARD replays under (a hand run shares its level's auto policy + a tag). */
  policy: string;
  kata?: string;
  tag?: string;
  run: RunResult;
}

/** Log line prefixes the evidence script reads (mint hash vs replay hash, side by side). */
export const MINT_LOG = "dojo-share-mint";
export const REPLAY_LOG = "dojo-share-replay";

/** The share URL for a payload: the payload body in the HASH (Pages-safe, no server). */
export function campusShareUrl(payload: string): string {
  const body = payload.replace(/^#?c?=?/, "");
  return `${window.location.origin}${window.location.pathname}#card=${body}`;
}

/** The `card` parameter of the current URL (hash first — the shipped form; `?card=` also reads). */
export function shareCardParam(url: URL = new URL(window.location.href)): string | null {
  const inHash = /(?:^|[#&])card=([^&]+)/.exec(url.hash);
  const raw = inHash ? decodeURIComponent(inHash[1]!) : url.searchParams.get("card");
  if (!raw) return null;
  return raw.startsWith("#c=") ? raw : `#c=${raw}`;
}

/** The card's thumbnail time: 55 % into the traffic the run actually generated. */
function thumbnailTime(run: RunResult, level: Level): number {
  const duration = Number(level.duration ?? 0) || (run.end_time || 0);
  return Math.max(1, Math.round(Math.min(run.end_time || duration, duration) * 0.55));
}

/** Mint a card through the engine (it re-runs the level and embeds that run's hash). */
export async function mintCampusShare(ctx: CampusShareContext):
  Promise<{ payload: string; url: string; hash: string }> {
  const mint = await bridge.shareEncode({
    level: encodableLevel(ctx.level),
    seed: ctx.seed,
    policy: ctx.policy,
    kata: ctx.kata ?? null,
    levelId: ctx.levelId,
  });
  console.log(`${MINT_LOG} level=${ctx.levelId} seed=${ctx.seed} policy=${ctx.policy} `
    + `hash=${mint.hash} payload=${mint.payload.length}B`);
  return { payload: mint.payload, url: campusShareUrl(mint.payload), hash: mint.hash };
}

/** A "Share this run" button for the review screen's action row. */
export function mountCampusShareButton(host: HTMLElement, ctx: CampusShareContext): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "share-button campus-share-button";
  button.textContent = "Share this run";
  button.title = "mint a replayable campus share card (thumbnail + verified link)";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "minting…";
    void mintCampusShare(ctx)
      .then(async ({ payload, url }) => {
        await openShareCardDialog(ctx, { payload, url });
        // The card is up: the button is a way back to it, not a one-way door.
        button.textContent = "Share this run";
        button.disabled = false;
      })
      .catch((error: unknown) => {
        button.textContent = "share failed";
        console.error(error);
        window.setTimeout(() => {
          button.textContent = "Share this run";
          button.disabled = false;
        }, 2500);
      });
  });
  host.append(button);
  return button;
}

/** The minted card: thumbnail + text card + copy box. */
export async function openShareCardDialog(
  ctx: CampusShareContext, mint: { payload: string; url: string },
): Promise<void> {
  const panel = cardShell("Share card", ctx.title, mint.payload);
  panel.append(cardText(ctx, ctx.run, ctx.run.score));
  // The minted card is drawn in the PLAYER'S campus (their owned buildings sprite the thumbnail);
  // a card being VIEWED gets the bare campus — the card cannot carry the minter's save, and the
  // art must not imply it can.
  await addThumbnail(panel, {
    level: ctx.level, policy: ctx.policy, ...(ctx.kata ? { kata: ctx.kata } : {}),
    t: thumbnailTime(ctx.run, ctx.level), buildings: await ownedBuildings(),
  }, ctx);
  addLinkRow(panel, mint.url);
  addClose(panel);
}

/** The mint dialog's own close row stays a plain Close. */

/* -------------------------------------------------------------- the view -- */

export interface CardViewOptions {
  payload: string;
  host?: HTMLElement;
  /** open the verified run in watch mode (the shell owns the presentation) */
  onReplay: (run: RunResult, card: DecodedShareCard) => Promise<void>;
}

/**
 * The `#card=` route: decode → verify with the engine → badge or tampered banner → the run opens in
 * watch mode. The verdict is the engine's, never a client-side guess: `share_replay` re-runs and
 * compares the trajectory hash.
 */
export async function openShareCardView(opts: CardViewOptions): Promise<void> {
  const card = decodeShareCard(opts.payload);
  const panel = cardShell("Share card", card?.level?.id ? String(cardLevelId(card)) : "run",
                           opts.payload);
  if (!card) {
    banner(panel, false, "malformed share card — the payload did not decode");
    addClose(panel);
    return;
  }
  const levelId = cardLevelId(card);
  const resolved = await resolveReplayLevel(card);
  let ok = false;
  let detail = "";
  let replay: Awaited<ReturnType<typeof bridge.shareReplay>> | null = null;
  if (resolved.level) {
    try {
      replay = await bridge.shareReplay(opts.payload, resolved.level);
      ok = replay.ok;
      detail = ok ? replay.trajectory_hash
        : `got ${replay.trajectory_hash} \u2260 ${replay.expected_hash ?? "?"}`;
      console.log(`${REPLAY_LOG} level=${levelId} seed=${card.seed} ok=${ok} `
        + `expected=${replay.expected_hash ?? "?"} got=${replay.trajectory_hash}`);
    } catch (error) {
      detail = error instanceof BridgeError ? `${error.code}: ${error.message}` : String(error);
    }
  } else {
    detail = resolved.note ?? "the card does not carry a level this build can replay";
  }
  banner(panel, ok, ok ? `verified replay — the engine re-ran it and the trajectory hash matches `
    + `(${detail})` : `tampered or unreplayable card — ${detail}`);

  panel.append(cardTextFromCard(card, replay));
  await addThumbnail(panel, {
    level: resolved.level ?? withoutNulls((card.level ?? null) as Level | null),
    policy: card.kata ? "kata" : card.policy ?? "fifo",
    ...(card.kata ? { kata: String(card.kata) } : {}),
    t: Math.max(1, Math.round(Number((resolved.level ?? card.level)?.duration ?? 1) * 0.55)),
  });
  // A verified card opens in watch mode; a tampered one offers no replay at all (Close only).
  addClose(panel, ok
    ? { label: "Watch the replay \u25b8", onRun: async () => {
      const run = await bridge.runLevel(resolved.level!, {
        seed: card.seed,
        policy: card.kata ? "kata" : card.policy ?? "fifo",
        ...(card.kata ? { kata: String(card.kata) } : {}),
      });
      await opts.onReplay(run, card);
    } }
    : undefined);
}

/**
 * The dict `share_replay` needs: for a shipped level, the fetched canonical dict merged UNDER the
 * card's embedded fields (jobs can only come from the file; every asserted fact from the card).
 * A card whose level cannot be reconstructed here reports why instead of lying about a verdict.
 */
async function resolveReplayLevel(card: DecodedShareCard):
  Promise<{ level: Level | null; note?: string }> {
  const embedded = (card.level ?? null) as Level | null;
  const id = cardLevelId(card);
  if (/^level[1-9]$/.test(id)) {
    try {
      const shipped = await fetchJson<Level>(`levels/${id}.json`);
      return { level: { ...shipped, ...withoutNulls(embedded) } };
    } catch (error) {
      return { level: withoutNulls(embedded),
        note: `shipped level ${id} could not be fetched (${error instanceof Error ? error.message : error})` };
    }
  }
  if (id === "endless") {
    const level = withoutNulls(embedded);
    return { level: Array.isArray(level.jobs) ? level : null,
             note: "endless cards are not replayable here — the growth stream is not in the card" };
  }
  const inline = withoutNulls(embedded);
  return { level: Object.keys(inline).length ? inline : null,
           note: embedded ? undefined : "card carries no level" };
}

/**
 * Drop the `null`s a card's embedded level dict carries for keys the level simply does not have
 * (`encode_card` writes `level.get("sensors")`, and a level without sensors yields null). They are
 * harmless to `replay_card` — it runs with `validate=False` — but as a *run* level `sensors: null`
 * fails validation outright, so a merge-under must never let a key the card lacks overwrite a real
 * value from the level file. (Found the honest way: the card view verified, then "Watch the replay"
 * died on `sensors must be a subset of [...]`.)
 */
function withoutNulls(level: Record<string, unknown> | null): Level {
  const out: Level = {};
  for (const [key, value] of Object.entries(level ?? {})) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ parts -- */

let top: HTMLElement | null = null;

function closeTop(): void {
  top?.remove();
  top = null;
}

function cardShell(heading: string, title: string, payload: string): HTMLElement {
  closeTop();
  const overlay = document.createElement("div");
  overlay.className = "share-overlay";
  const panel = document.createElement("section");
  panel.className = "share-modal campus-share-card";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") closeTop();
  });
  const h = document.createElement("h3");
  h.textContent = `${heading} — ${title}`;
  const line = document.createElement("p");
  line.className = "share-payload hash";
  line.textContent = `${payload.length} chars · opens in any browser, replays with the engine`;
  panel.append(h, line);
  overlay.append(panel);
  document.body.append(overlay);
  top = panel;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeTop();
  });
  return panel;
}

function banner(panel: HTMLElement, ok: boolean, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `share-banner ${ok ? "ok" : "bad"}`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = ok ? `verified replay \u2713 ${text}` : `card tampered \u2717 ${text}`;
  panel.prepend(el);
  return el;
}

/** The compact text card — the facts a run is, in the run's own words. */
function cardText(ctx: CampusShareContext, run: RunResult, score: number | undefined): HTMLElement {
  const m = run.metrics;
  return textCard([
    ["city", ctx.levelId],
    ["seed", String(ctx.seed)],
    [ctx.kata ? "kata" : "policy", ctx.kata ? "written here" : ctx.policy],
    ["score", score === undefined ? "—" : String(score)],
    ["traffic", `${formatTime(run.end_time)} · ${run.jobs.filter((j) => j.state === "done").length}`
      + `/${run.jobs.length} served`],
    ["utilization", `${(m.utilization * 100).toFixed(1)}%`],
    ["wait p95", formatTime(m.wait_p95)],
    ["fairness", m.fairness.toFixed(3)],
    ["hash", run.trajectory_hash],
    ...(ctx.tag ? [["note", ctx.tag] as [string, string]] : []),
  ]);
}

function cardTextFromCard(card: DecodedShareCard,
                          replay: Awaited<ReturnType<typeof bridge.shareReplay>> | null): HTMLElement {
  const m = replay?.metrics;
  const end = card.level && typeof card.level.duration === "number"
    ? `${formatTime(card.level.duration)} horizon` : "";
  return textCard([
    ["city", cardLevelId(card) || String(card.level_id ?? "?")],
    ["seed", String(card.seed)],
    [card.kata ? "kata" : "policy", card.kata ? "written in the card" : card.policy ?? "fifo"],
    ...(m ? ([["score", replay?.score === undefined ? "—" : String(replay.score)],
             ["utilization", `${(m.utilization * 100).toFixed(1)}%`],
             ["wait p95", formatTime(m.wait_p95)],
             ["fairness", m.fairness.toFixed(3)]] as [string, string][]) : []),
    ["promised hash", card.hash ?? "?"],
    ...(end ? [["traffic", end] as [string, string]] : []),
  ]);
}

function textCard(rows: [string, string][]): HTMLElement {
  const dl = document.createElement("dl");
  dl.className = "share-card-text";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.className = "hash";
    dd.textContent = v;
    dl.append(dt, dd);
  }
  return dl;
}

/** The campus thumbnail, drawn into the card element by the campus painter. */
async function addThumbnail(panel: HTMLElement, req: ThumbRequest,
                            ctx?: CampusShareContext): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.className = "share-scene-thumb";
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    `Campus thumbnail of ${ctx?.title ?? "a run"} (seed ${ctx?.seed ?? "?"}, `
      + `${ctx?.policy ?? req.policy ?? "policy"}).`,
  );
  panel.querySelector(".share-card-text")
    ? panel.insertBefore(canvas, panel.querySelector(".share-card-text"))
    : panel.append(canvas);
  try {
    await paintCampusThumbnail(canvas, req);
  } catch (error) {
    const note = document.createElement("p");
    note.className = "board-status";
    note.textContent = `thumbnail failed: ${error instanceof Error ? error.message : error}`;
    panel.append(note);
  }
}

function addLinkRow(panel: HTMLElement, url: string): void {
  const row = document.createElement("div");
  row.className = "share-url-row";
  const input = document.createElement("input");
  input.className = "share-url";
  input.type = "text";
  input.readOnly = true;
  input.value = url;
  input.setAttribute("aria-label", "Share link for this run");
  input.addEventListener("focus", () => input.select());
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy link";
  const status = document.createElement("span");
  status.className = "share-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(url)
      .then(() => {
        status.textContent = "link copied \u2713";
      })
      .catch(() => {
        status.textContent = "select + \u2318C";
        input.select();
      });
  });
  row.append(input, copy, status);
  panel.append(row);
}

/**
 * The card's action row. `run` (only for a VERIFIED card) is a second button that re-runs the
 * card's own level + seed + policy and hands the finished run to the shell's watch presentation.
 */
function addClose(panel: HTMLElement, run?: { label: string; onRun: () => Promise<void> }): void {
  const actions = document.createElement("div");
  actions.className = "share-actions callout-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", closeTop);
  actions.append(close);
  if (run) {
    const watch = document.createElement("button");
    watch.type = "button";
    watch.textContent = run.label;
    watch.addEventListener("click", () => {
      watch.disabled = true;
      watch.textContent = "running\u2026";
      void run.onRun()
        .then(() => closeTop())
        .catch((error: unknown) => {
          watch.textContent = "replay failed";
          watch.disabled = false;
          console.error(error);
        });
    });
    actions.append(watch);
  }
  panel.append(actions);
  close.focus({ preventScroll: true });
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, document.baseURI).href);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}
