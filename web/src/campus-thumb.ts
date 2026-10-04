/**
 * A real campus frame, drawn small (Art 7b): the city board's tile thumbnails and the share card's
 * thumbnail. It is NOT a placeholder pipeline — every pixel comes from the same two modules the live
 * campus uses (`campus.ts` projects an engine snapshot, `campus-render.ts` paints it), just driven
 * headlessly instead of by the rAF loop.
 *
 * HOW a frame is made (and why it is stepped in slices):
 *   start(level, policy) -> `SLICES` × step_until up to the frame time -> buildScene -> render.
 * A SINGLE jump would be cheaper but dishonest-looking: `_snapshot.unseen` only lists jobs whose
 * submit time is still ahead, so a job that submitted between t=0 and the jump was never `unseen`
 * in any snapshot this viewer saw, and `collect`'s fallback would draw it as an unknown owner with
 * a 0-length body (the `user: "?"` shell). Stepping in slices is what `CampusPlay` does for the same
 * reason, so the union view accumulates the same facts the live campus has. Thumbnails are therefore
 * the frames the live campus shows at that sim time, not a summary invented for the tile.
 *
 * WHERE it paints: an OFFSCREEN canvas (never mounted, never `campusStage`), scaled by drawImage
 * into whatever canvas the caller hands over. `CampusPlay.resizeNow()` measures the live canvas's
 * `parentElement`, so a thumbnail can never move it — which is why the Art 3 visual baselines are
 * untouched by Art 7b. The offscreen frame is laid out at THUMB_W×THUMB_H because `campus.ts`'
 * layout needs that much room for its lots and road band (`x = width - PAD - 300`,
 * `roadY = height - PAD - 150`); a 240 px canvas would push both off-frame.
 *
 * COST / lifetime: one partial run per frame, cached for the page session — and the cache holds
 * the PROMISE, not the finished canvas (review 7b-F3: two board opens while one frame was still
 * drawing used to START the run twice). The stepping handle is released with `step_close`
 * (review 7b: `step_result` drained the rest of the level to build a summary nobody reads —
 * seconds of frozen campus per tile). A handle whose close fails is simply left behind: nine
 * per page at worst, freed by a reload.
 */

import { bridge, type Level, type StepState } from "./bridge";
import { buildScene, type SnapshotLike } from "./campus";

/** Layout size of the offscreen frame (2:1 — the tile canvases keep the same aspect). */
export const THUMB_W = 640;
export const THUMB_H = 320;

/** Snapshots per frame: enough arrivals to be seen before they queue (see the header note). */
const SLICES = 6;

/** The frame time as a fraction of the level's horizon: early enough to be calm, late enough to
 *  have traffic parked AND queued. */
const FRAME_FRACTION = 0.3;

type JobView = NonNullable<SnapshotLike["jobs"]>[number];
type BuildingView = NonNullable<Parameters<typeof buildScene>[0]["buildings"]>;

export interface ThumbRequest {
  /** The level dict to frame — a city EDITION where the tile is a scripted city. */
  level: Level;
  policy?: string;
  kata?: string;
  /** sim time of the frame; default FRAME_FRACTION of the horizon */
  t?: number;
  /** owned buildings to sprite (progression_view.buildings); none = the bare campus */
  buildings?: BuildingView;
}

const frames = new Map<string, Promise<HTMLCanvasElement>>();

/** Drop every cached frame (a theme/token change or a test harness reset). */
export function clearThumbCache(): void {
  frames.clear();
}

/**
 * The frame canvas for a request (cached per session by everything that can affect the pixels:
 * level id + seed + duration + policy + kata length + frame time + owned buildings). The CACHE
 * HOLDS THE PROMISE (review 7b-F3): concurrent requests for the same frame await one draw, and
 * a failed draw evicts itself so a later open can retry.
 */
export async function campusThumbFrame(req: ThumbRequest): Promise<HTMLCanvasElement> {
  const plan = await bridge.watchPlan(req.level);
  const duration = plan.duration || Number(req.level.duration ?? 0);
  const t = Math.max(1, Math.round(req.t ?? duration * FRAME_FRACTION));
  const policy = req.policy ?? String(req.level.default_policy ?? "fifo");
  const buildings = [...(req.buildings ?? [])].map((b) => b.id).join(",");
  const key = `${String(req.level.id ?? "?")}|${String(req.level.seed ?? 0)}|${duration}|`
    + `${policy}|${req.kata?.length ?? 0}|${t}|${buildings}`;
  const cached = frames.get(key);
  if (cached) return cached;
  const drawing = drawThumbFrame(req, t, policy, plan.stride).catch((error: unknown) => {
    if (frames.get(key) === drawing) frames.delete(key);   // never cache a failed frame
    throw error;
  });
  frames.set(key, drawing);
  return drawing;
}

async function drawThumbFrame(req: ThumbRequest, t: number, policy: string, stride: number):
  Promise<HTMLCanvasElement> {
  const nodes: { id: string; partition: string; site?: string }[] = [];
  const jobs = new Map<string, JobView>();
  const started = await bridge.startRun(req.level, { policy, kata: req.kata ?? null });
  let state = started.state;
  nodes.push(...(started.nodes ?? []).map((n) => ({ id: n.id, partition: n.partition,
                                                    site: n.site })));
  let snap = absorb(state, jobs, nodes);
  for (let i = 1; i <= SLICES; i++) {
    if (snap.done) break;
    const res = await bridge.stepUntil(started.handle, Math.round((t * i) / SLICES));
    state = res.state;
    snap = absorb(state, jobs, nodes);
  }

  const off = document.createElement("canvas");
  off.style.width = `${THUMB_W}px`;
  off.style.height = `${THUMB_H}px`;
  const mod = await import("./campus-render");
  const renderer = new mod.CampusRenderer(off, { reducedMotion: true });
  renderer.resize(THUMB_W, THUMB_H);
  renderer.render(buildScene({
    width: THUMB_W, height: THUMB_H, nodes, jobs: snap.jobs, snap,
    clock: cityClock(snap.now, stride),
    buildings: req.buildings,
  }), null, 1);
  renderer.destroy();

  // End the stepping session (see the header note): `step_close`, not a `step_result` drain.
  await bridge.stepClose(started.handle).catch(() => undefined);
  return off;
}

/** Paint the frame for `req` into a mounted canvas (scaled to that canvas's own CSS box). */
export async function paintCampusThumbnail(
  canvas: HTMLCanvasElement, req: ThumbRequest,
): Promise<void> {
  const frame = await campusThumbFrame(req);
  // Review 7b-F3: a board closed while this tile was drawing left a DETACHED canvas — painting
  // into it measured 0×0 and drew a scaled lie into whatever inherited the context. If the tile
  // is gone, so is this paint.
  if (!canvas.isConnected) return;
  const w = Math.max(1, Math.round(canvas.clientWidth || canvas.width || THUMB_W / 2));
  const h = Math.max(1, Math.round(canvas.clientHeight || w * (THUMB_H / THUMB_W)));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(frame, 0, 0, w, h);
}

/** The city calendar for a scene (the same mapping `CampusPlay.sceneFrom` uses for cities). */
function cityClock(now: number, stride: number): { week: number; day: number; sun: number } {
  const step = Math.max(1, stride);
  return { week: 1, day: Math.floor(now / step) + 1,
           sun: ((now % (step * 7)) / (step * 7)) || 0 };
}

/**
 * Absorb one snapshot into the job union view — the same three fallbacks `CampusPlay.collect`
 * applies (running decorations, `jobs`/`unseen` from the payload, shells for running/queued ids
 * the viewer never met). Kept local and read-only: it decides nothing, and the live loop is
 * deliberately not refactored onto it so no campus frame can shift.
 */
function absorb(state: StepState, jobs: Map<string, JobView>,
               nodes: { id: string; partition: string; site?: string }[]): SnapshotLike {
  const s = state as StepState & { jobs?: JobView[]; unseen?: JobView[] };
  for (const r of state.running) {
    const j = jobs.get(r.id);
    if (j) {
      j.start = r.start;
      if (r.end !== undefined) j.end = r.end;
    }
  }
  if (s.jobs) for (const j of s.jobs) jobs.set(j.id, { ...jobs.get(j.id), ...j } as JobView);
  for (const u of s.unseen ?? []) {
    if (!jobs.has(u.id)) jobs.set(u.id, { ...u, start: null, end: null, placed: [] } as JobView);
  }
  for (const r of state.running) {
    if (!jobs.has(r.id)) {
      jobs.set(r.id, { id: r.id, user: "?", nodes: r.nodes.length, est: 0, submit: state.now,
                       start: r.start, end: r.end ?? null, state: "unfinished",
                       placed: r.nodes } as JobView);
    }
  }
  for (const id of state.queued) {
    if (!jobs.has(id)) {
      jobs.set(id, { id, user: "?", nodes: 1, est: 0, submit: state.now, start: null, end: null,
                     state: "unfinished", placed: [] } as JobView);
    }
  }
  return {
    now: state.now,
    queued: state.queued,
    running: state.running,
    reserved: state.reserved,
    pressure: state.pressure,
    overflow: state.overflow,
    done: state.done,
    jobs: [...jobs.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    nodes,
  };
}
