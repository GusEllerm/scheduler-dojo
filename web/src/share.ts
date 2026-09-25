/**
 * Stage 9 share cards: mint a replayable `#c=` payload after any successful run (watch / hand /
 * kata), present a Canvas-drawn PNG card with copy-link + download, and decode an incoming
 * `?c=`/`#c=` link on boot so a visit can be replayed + hash-verified (see share.ts consumers in
 * main.ts; the verification itself runs Python-side in `share_replay`).
 *
 * Payload/URL shape: the engine returns the payload string `#c=<base64url canonical JSON>`; the
 * share URL is `<origin><pathname>?c=<base64url body>` (base64url is already URL-safe). For a
 * shipped level we hand the engine the *fetched level dict* inline (its own seed/policy/kata), so
 * levels whose jobs are an explicit list (level7/8) still mint a hash — and on replay we hand the
 * same dict back, since the card schema itself only embeds cluster/generator-level data.
 */

import { EditorView } from "@codemirror/view";
import { bridge, type Level, type RunResult } from "./bridge";
import { drawShareCard } from "./share-card";

/** The decoded card JSON (`scheduler_dojo.share.card.decode_card`'s shape). */
export interface DecodedShareCard {
  v: number;
  seed: number;
  level_id?: string | null;
  level?: Record<string, unknown> | null;
  policy?: string | null;
  kata?: string | null;
  hash?: string | null;
}

/** Everything needed to mint + draw a card for one finished run. */
export interface ShareContext {
  /** The live level dict (fetched JSON). A `generator: {}` stub is added for explicit-jobs
   *  levels so the engine's card encoder can embed it — `load_jobs` prefers `jobs`, so the
   *  trajectory (and hash) are unchanged. */
  level: Level;
  levelId: string;
  title: string;
  seed: number;
  /** The policy the *card* replays under ("hand" runs share their level's default policy). */
  policy: string;
  /** Kata source for a kata run (embedded verbatim in the card). */
  kata?: string;
  run: RunResult;
  belt?: string;
  tag?: string;
}

/** The `c` parameter of the current URL, normalized to a `#c=…` payload (search or hash). */
export function shareParam(url: URL = new URL(window.location.href)): string | null {
  const inSearch = url.searchParams.get("c");
  if (inSearch) return inSearch.startsWith("#c=") ? inSearch : `#c=${inSearch}`;
  const match = /(?:^|[#&])c=([^&]+)/.exec(url.hash);
  if (match && match[1]) {
    const body = decodeURIComponent(match[1]);
    return body.startsWith("#c=") ? body : `#c=${body}`;
  }
  return null;
}

/** Decode a payload client-side for its metadata (level id / seed / policy) — the *verification*
 *  stays Python-side in `share_replay`. Returns null for a malformed/tampered payload body. */
export function decodeShareCard(payload: string): DecodedShareCard | null {
  const body = payload.startsWith("#c=") ? payload.slice(3) : payload.replace(/^#/, "");
  try {
    const padded = body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (body.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const card = JSON.parse(new TextDecoder().decode(bytes)) as DecodedShareCard;
    if (!card || typeof card !== "object" || card.v !== 1 || typeof card.seed !== "number") return null;
    return card;
  } catch {
    return null;
  }
}

/** Which shipped level an incoming card refers to (inline cards embed their level's id). */
export function cardLevelId(card: DecodedShareCard): string {
  const inline = card.level && typeof card.level.id === "string" ? card.level.id : null;
  return inline ?? (typeof card.level_id === "string" ? card.level_id : "") ?? "";
}

/** The share URL for a payload: `<origin><pathname>?c=<base64url body>`. */
export function shareUrl(payload: string): string {
  const body = payload.startsWith("#c=") ? payload.slice(3) : payload;
  return `${window.location.origin}${window.location.pathname}?c=${body}`;
}

/** A level dict the card encoder can embed (explicit-jobs levels need a `generator` key). */
function encodableLevel(level: Level): Level {
  if (!("generator" in level) && Array.isArray(level.jobs)) return { ...level, generator: {} };
  return level;
}

/** Mint the card payload through the engine (it re-runs + embeds the trajectory hash). */
export async function mintShare(context: ShareContext): Promise<{ payload: string; url: string }> {
  const mint = await bridge.shareEncode({
    level: encodableLevel(context.level),
    seed: context.seed,
    policy: context.policy,
    kata: context.kata ?? null,
    levelId: context.levelId,
  });
  return { payload: mint.payload, url: shareUrl(mint.payload) };
}

/** The kata source currently in the editor mounted under `host` (null when not in kata mode). */
export function currentKataSource(host: HTMLElement): string | null {
  const node = host.querySelector(".cm-content") ?? host.querySelector(".cm-editor");
  const view = node ? EditorView.findFromDOM(node as HTMLElement) : undefined;
  return view ? view.state.doc.toString() : null;
}

/** A "Share" button that mints the card and opens the share modal. */
export function mountShareButton(container: HTMLElement, context: ShareContext): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "share-button";
  button.textContent = "Share";
  button.title = "mint a replayable share card (PNG + copy link)";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "minting…";
    void mintShare(context)
      .then(({ payload, url }) => {
        openShareModal(context, payload, url);
        return copyText(url);
      })
      .catch((error: unknown) => {
        button.textContent = "share failed";
        console.error(error);
        window.setTimeout(() => {
          button.textContent = "Share";
        }, 2500);
        return undefined;
      })
      .finally(() => {
        button.disabled = false;
        if (button.textContent !== "share failed") button.textContent = "Share";
      });
  });
  container.append(button);
  return button;
}

/** A verified/tampered banner for a replayed card, prepended into `parent`. */
export function showShareBanner(parent: HTMLElement, ok: boolean, detail: string): HTMLElement {
  const banner = document.createElement("div");
  banner.className = `share-banner ${ok ? "ok" : "bad"}`;
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.textContent = ok
    ? `replayed from share card — verified ✓ (hash ${detail})`
    : `card tampered / hash mismatch ✗ (${detail})`;
  parent.prepend(banner);
  return banner;
}

// --- modal -----------------------------------------------------------------------------

let overlay: HTMLElement | null = null;
/** What had focus before the card modal opened — closing hands the caret back to it. */
let previousFocus: HTMLElement | null = null;

function openShareModal(context: ShareContext, payload: string, url: string): void {
  closeShareModal();
  const root = document.createElement("div");
  root.className = "share-overlay";
  root.addEventListener("click", (event) => {
    if (event.target === root) closeShareModal();
  });
  const modal = document.createElement("div");
  modal.className = "share-modal";
  // A labelled modal dialog (Stage 10 a11y): focus moves in on open, Tab stays inside, Escape closes
  // (the Escape listener is already registered at the bottom of this function).
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "share-title");

  const heading = document.createElement("h3");
  heading.id = "share-title";
  heading.textContent = "Share card";
  const canvas = document.createElement("canvas");
  canvas.className = "share-card-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    `Share card for ${context.title} (level ${context.levelId}, seed ${context.seed}, policy `
      + `${context.policy})${context.run.score === undefined ? "" : `, score ${context.run.score}`}.`,
  );
  drawShareCard(canvas, {
    title: context.title,
    levelId: context.levelId,
    seed: context.seed,
    policy: context.policy,
    ...(context.run.score === undefined ? {} : { score: context.run.score }),
    ...(context.belt ? { belt: context.belt } : {}),
    metrics: context.run.metrics,
    jobs: context.run.jobs,
    endTime: context.run.end_time,
    hash: context.run.trajectory_hash,
    ...(context.tag ? { tag: context.tag } : {}),
  });

  const urlRow = document.createElement("div");
  urlRow.className = "share-url-row";
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
  copy.setAttribute("aria-label", "Copy share link to clipboard");
  const status = document.createElement("span");
  status.className = "share-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  copy.addEventListener("click", () => {
    void copyText(url).then((done) => {
      status.textContent = done ? "link copied ✓" : "select + ⌘C";
    });
  });
  urlRow.append(input, copy, status);

  const actions = document.createElement("div");
  actions.className = "share-actions";
  const download = document.createElement("a");
  download.className = "share-download";
  download.textContent = "Download PNG";
  download.download = `dojo-${context.levelId}-${context.seed}.png`;
  download.href = canvas.toDataURL("image/png");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", closeShareModal);
  actions.append(download, close);

  const payloadLine = document.createElement("div");
  payloadLine.className = "share-payload";
  payloadLine.textContent = `${payload.length} chars · ${payload.slice(0, 48)}…`;
  payloadLine.title = payload;

  modal.append(heading, canvas, urlRow, actions, payloadLine);
  root.append(modal);
  document.body.append(root);
  overlay = root;
  previousFocus = document.activeElement as HTMLElement | null;
  input.focus();
  modal.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") return; // handled by onKey below
    if (event.key !== "Tab") return;
    const items = [...modal.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input")];
    if (!items.length) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !modal.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("keydown", onKey, { once: true });
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeShareModal();
  else window.addEventListener("keydown", onKey, { once: true });
}

function closeShareModal(): void {
  overlay?.remove();
  overlay = null;
  // The Share button is disabled while the card is minting (so it was not focusable when the modal
  // opened and `activeElement` was the body) — hand focus back to the button itself in that case.
  const target =
    previousFocus && previousFocus !== document.body
      ? previousFocus
      : document.querySelector<HTMLElement>(".share-row .share-button");
  target?.focus?.();
  previousFocus = null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
