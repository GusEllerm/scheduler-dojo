/* Campus scene model — the pure TS view of an engine snapshot (phase two).

CONTRACT (docs/vault/Concepts/Campus.md is the mapping authority; this file is the types):
the scene is a 100% derived, allocation-cheap projection of `{now, queued, running, reserved,
pressure, overflow, jobs/nodes}` from `bridge` snapshots. It decides NOTHING and animates
NOTHING — `campus-render.ts` paints it, `campus-hit.ts` hit-tests it, `main.ts` advances the run.
Layout is deterministic in (canvas width, height, dpr, node list, scene): same inputs ⇒ pixel-
identical output, which is what the visual-baseline harness relies on.

Coordinates are CSS pixels; the renderer applies devicePixelRatio itself.
 */

export type VehicleState =
  | "queued" | "chosen" | "reserved" | "running" | "done" | "unseen"
  | "timeout" | "preempted" | "transferring";

export interface Vehicle {
  id: string;
  user: string;            // → neighbourhood index (stable order of first appearance)
  state: VehicleState;
  nodes: number;           // width in bays (nodes requested)
  est: number;             // claimed walltime (length axis basis, seconds)
  submit: number;          // sim seconds
  start: number | null;
  end: number | null;      // includes transfer delay when known
  placed: string[];        // real bay ids when running/placed
  // layout-computed by buildScene (see RoadSpec): rank = policy order in the snapshot queue
  rank?: number;
}

export interface Bay {
  id: string;
  lot: string;             // partition name (lot id)
  site: string;
  col: number; row: number;        // position inside the lot grid
  occupiedBy: string | null;       // job id running here now
  reservedFor: string | null;      // job id with a live cone at `now`
  reservedUntil: number | null;
  idle: boolean;                   // free AND nothing queued wants it this tick (wasted hint)
  material: "default" | "gpu" | "himem" | "remote";  // from partition/site name
}

export interface Lot {
  id: string;              // partition name
  material: Bay["material"];
  site: string;
  cols: number; rows: number;
  x: number; y: number; w: number; h: number;   // layout rect
}

export interface Neighbourhood {
  user: string;
  index: number;           // 0..7 → nb token + shape (hex, diamond, pentagon, triangle, octagon…)
  label: string;
  x: number; y: number; r: number;
  ring: number;            // 0..1 from snapshot pressure (never smoothed here)
  overflow: boolean;
}

export interface RoadSpec {
  x: number; y: number; w: number; h: number;
  laneH: number;
}

export interface CampusScene {
  now: number;
  week: number; day: number; sun: number;        // from bridge calendar_at/watch_plan stride math
  vehicles: Vehicle[];                            // ALL known jobs, laid out by state
  queuedOrder: string[];                          // snapshot `queued` (engine order)
  chosen: string | null;                          // head of queuedOrder at a decision, else null
  bays: Bay[];
  lots: Lot[];
  neighbourhoods: Neighbourhood[];
  road: RoadSpec;
  booth: { x: number; y: number; w: number; h: number; staffed: boolean; revealed?: boolean };
  /** hand mode (Art 4): the vehicle the player picked on the road, null when none */
  selectedId?: string | null;
  /** hand mode: bays staged for the selected vehicle + a client-side fit hint (the engine still
   *  validates on place — this is a ghost preview, not a decision) */
  staged?: { bays: string[]; fits: boolean; user: string } | null;
  overflowUser: string | null;
  done: boolean;
}

export interface SnapshotLike {
  now: number;
  queued: string[];
  running: { id: string; nodes: string[]; start: number | null; end?: number }[];
  reserved?: Record<string, number>;
  pressure?: Record<string, number>;
  overflow?: string;
  done?: boolean;
  jobs?: { id: string; user: string; nodes: number; est: number; submit: number;
           start: number | null; end: number | null; state: string;
           placed?: string[]; site?: string; home?: string }[];
  nodes?: { id: string; partition: string; site?: string }[];
}

export interface LayoutInput {
  width: number; height: number;
  nodes: { id: string; partition: string; site?: string }[];
  /** jobs seen so far (run/start data): the union view the caller maintains */
  jobs: SnapshotLike["jobs"];
  snap: SnapshotLike;
  clock: { week: number; day: number; sun: number };
  staffed?: boolean;
  /** hand mode extras (all optional; live mode leaves them unset and the scene is unchanged) */
  selected?: string | null;
  staged?: CampusScene["staged"];
  boothRevealed?: boolean;
}

/** Pure layout + projection. Deterministic: no Date, no Math.random, no iter over object sets
 *  (user index order = first appearance in sorted job ids). */
export function buildScene(input: LayoutInput): CampusScene {
  return layoutScene(input);
}

/* ------------------------------------------------------------------ layout -- */

const PAD = 24;
const TOP_STRIP = 44;
const NB_R = 34;

function materialOf(partition: string, remote = false): Bay["material"] {
  const p = partition.toLowerCase();
  if (remote) return "remote";
  if (p.includes("gpu")) return "gpu";
  if (p.includes("mem")) return "himem";
  return "default";
}

function lotKey(n: { partition: string; site?: string }): string {
  return `${n.site ?? "s0"}/${n.partition}`;
}

function layoutScene(inp: LayoutInput): CampusScene {
  const { width, height, nodes, jobs, snap } = inp;
  const jobsById = new Map((jobs ?? []).map((j) => [j.id, j]));

  // ---- neighbourhoods: user order = first appearance in job-id order ----------
  const userOrder: string[] = [];
  for (const j of [...(jobs ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!userOrder.includes(j.user)) userOrder.push(j.user);
  }
  for (const id of snap.queued) {
    const j = jobsById.get(id);
    if (j && !userOrder.includes(j.user)) userOrder.push(j.user);
  }
  const n = userOrder.length;
  const places = ringPlaces(n, width, height);
  const neighbourhoods: Neighbourhood[] = userOrder.map((user, i) => ({
    user, index: i % 8, label: user,
    x: places[i]?.x ?? PAD + 70, y: places[i]?.y ?? TOP_STRIP + NB_R + 30, r: NB_R,
    ring: Math.max(0, Math.min(1, snap.pressure?.[user] ?? 0)),
    overflow: (snap.overflow ?? "") === user,
  }));

  // ---- lots & bays: group nodes by (site, partition), row-pack <= 6 cols ------
  const groups = new Map<string, typeof nodes>();
  for (const nd of nodes) {
    const k = lotKey(nd);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(nd);
  }
  // The first site (sorted) is "home"; every other site's lots read as the remote material.
  const homeSite = [...new Set(nodes.map((nd) => nd.site ?? "s0"))].sort()[0];
  const lots: Lot[] = [];
  const bays: Bay[] = [];
  const lotLayouts = packLots(nodes, width, height);
  for (const [key, l] of lotLayouts.entries()) {
    lots.push({ id: key.split("/")[1] ?? "main", material: materialOf(l.partition, l.site !== homeSite),
                site: l.site,
                cols: l.cols, rows: l.rows, x: l.x, y: l.y, w: l.w, h: l.h });
  }
  const runByNode = new Map<string, string>();
  for (const r of snap.running) for (const nid of r.nodes) runByNode.set(nid, r.id);
  for (const nd of nodes) {
    const lot = lotLayouts.get(lotKey(nd))!;
    const idx = lot.order.indexOf(nd.id);
    bays.push({
      id: nd.id, lot: lotKey(nd).split("/")[1] ?? "main", site: lot.site,
      col: idx % lot.cols, row: Math.floor(idx / lot.cols),
      occupiedBy: runByNode.get(nd.id) ?? null,
      reservedFor: null,  // node-level cone attribution is not in the snapshot; cones hang on the
      reservedUntil: null, // vehicle (`Vehicle.state === "reserved"`), which owns the countdown
      idle: !runByNode.has(nd.id),
      material: materialOf(nd.partition, lot.site !== homeSite),
    });
  }

  // ---- road + vehicles --------------------------------------------------------
  const roadY = height - PAD - 150;
  const road: RoadSpec = { x: PAD, y: roadY, w: width - PAD * 2, h: 120, laneH: 30 };
  const vehicles: Vehicle[] = [];
  for (const j of jobs ?? []) {
    // State is DERIVED FROM THE CLOCK, never trusted from the job map: the union view carries
    // entries across steps and only `now` says where each vehicle is right now.
    let state: VehicleState;
    if ((j.submit ?? 0) > snap.now) state = "unseen";
    else if (snap.running.some((r) => r.id === j.id)) state =
      j.home && j.site && j.home !== j.site ? "transferring" : "running";
    else if (snap.reserved?.[j.id] !== undefined) state = "reserved";
    else if (j.state === "done" || j.state === "timeout") state = j.state === "timeout" ? "timeout" : "done";
    else if (j.end != null && j.end <= snap.now) state = "done";
    else state = "queued";
    vehicles.push({ id: j.id, user: j.user, state, nodes: j.nodes, est: j.est,
                    submit: j.submit, start: j.start, end: j.end, placed: j.placed ?? [] });
  }
  const rank = new Map(snap.queued.map((id, i) => [id, i]));
  for (const v of vehicles) if (v.state === "queued") v.rank = rank.get(v.id) ?? 0;

  const staffed = inp.staffed ?? true;
  return {
    now: snap.now,
    week: inp.clock.week, day: inp.clock.day, sun: inp.clock.sun,
    vehicles,
    queuedOrder: [...snap.queued],
    // "chosen" is the BOOTH's pick — an unstaffed hand booth has chosen nothing (Art 4).
    chosen: staffed ? snap.queued[0] ?? null : null,
    bays, lots, neighbourhoods, road,
    booth: { x: width - PAD - 190, y: roadY - 64, w: 120, h: 56, staffed,
             revealed: inp.boothRevealed ?? true },
    selectedId: inp.selected ?? null,
    staged: inp.staged ?? null,
    overflowUser: snap.overflow ?? null,
    done: !!snap.done,
  };
}

function ringPlaces(n: number, width: number, height: number) {
  const out: { x: number; y: number }[] = [];
  const roadY = height - PAD - 150;
  const ys = [TOP_STRIP + NB_R + 30, roadY / 2];
  // One neighbour sits left-of-center; otherwise spread up to four across, then a second row.
  const perRow = n === 1 ? 1 : Math.min(4, n);
  for (let i = 0; i < n; i++) {
    const col = i % perRow, row = Math.floor(i / perRow);
    const usable = width - PAD * 2 - 140;
    out.push({ x: PAD + 70 + (perRow === 1 ? usable / 2 : (col * usable) / (perRow - 1)),
               y: ys[(row % ys.length) as 0 | 1] ?? TOP_STRIP + NB_R + 30 });
  }
  return out;
}

interface LotBox { partition: string; site: string; cols: number; rows: number;
                   x: number; y: number; w: number; h: number; order: string[]; }

function packLots(nodes: LayoutInput["nodes"], width: number, height: number) {
  const groups = new Map<string, { partition: string; site: string; order: string[] }>();
  for (const nd of nodes) {
    const k = lotKey(nd);
    if (!groups.has(k)) groups.set(k, { partition: nd.partition, site: nd.site ?? "s0", order: [] });
    groups.get(k)!.order.push(nd.id);
  }
  const keys = [...groups.keys()].sort();
  const out = new Map<string, LotBox>();
  const lotsTop = TOP_STRIP + 12;
  const roadY = height - PAD - 150;
  const lotH = Math.min(120, Math.max(64, (roadY - lotsTop - 12 * keys.length) / Math.max(1, keys.length)));
  keys.forEach((k, i) => {
    const g = groups.get(k)!;
    const cols = Math.min(6, Math.max(1, g.order.length));
    const rows = Math.ceil(g.order.length / cols);
    const x = width - PAD - 300;
    const y = lotsTop + i * (lotH + 12);
    out.set(k, { partition: g.partition, site: g.site, cols, rows,
                 x, y, w: 280, h: lotH, order: g.order });
  });
  return out;
}


