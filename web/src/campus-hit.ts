/**
 * Campus hit testing (Art 3): point → entity, for hover/focus detail cards and tap-first input.
 * Pure geometry over the scene model (`campus.ts`); deterministic draw order = hit priority:
 * vehicles > bays > rings/neighbourhoods > buildings > lots > road. Reduced motion is irrelevant
 * here — hit boxes are layout, not animation.
 */

import type { Bay, CampusScene, Lot, Neighbourhood, Vehicle } from "./campus";

export type Hit =
  | { kind: "vehicle"; id: string; label: string; detail: string; x: number; y: number }
  | { kind: "bay"; id: string; label: string; detail: string; x: number; y: number }
  | { kind: "neighbourhood"; user: string; label: string; detail: string; x: number; y: number }
  | { kind: "booth"; label: string; detail: string; x: number; y: number }
  | { kind: "lot"; id: string; label: string; detail: string; x: number; y: number }
  | null;


/** Vehicle box on the road (queued placement), mirrors the renderer's left→rank order layout. */
export function vehicleBox(scene: CampusScene, v: Vehicle): { x: number; y: number; w: number; h: number } {
  const unitW = 12; // px per requested node (visual width)
  const w = Math.max(18, v.nodes * unitW);
  if (v.state === "queued" || v.state === "reserved" || v.state === "chosen") {
    const rank = v.rank ?? 0;
    const x = scene.road.x + 16 + rank * (scene.road.w - 40) / Math.max(12, scene.queuedOrder.length + 4);
    return { x, y: scene.road.y + scene.road.h / 2 - 12, w: Math.max(w, 24), h: 24 };
  }
  return { x: scene.road.x, y: scene.road.y, w: 0, h: 0 }; // running/done: hit via their bays
}

export function bayBox(scene: CampusScene, bay: Bay): { x: number; y: number; w: number; h: number } {
  const lot = scene.lots.find((l) => l.id === bay.lot);
  if (!lot) return { x: 0, y: 0, w: 0, h: 0 };
  const bw = (lot.w - 12) / lot.cols;
  const bh = (lot.h - 12) / lot.rows;
  return { x: lot.x + 6 + bay.col * bw, y: lot.y + 6 + bay.row * bh,
           w: bw - 4, h: Math.max(12, bh - 4) };
}

function inBox(p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

export function hitTest(scene: CampusScene, p: { x: number; y: number }): Hit {
  // vehicles (queued ones on the road)
  for (const v of scene.vehicles) {
    if (v.state !== "queued" && v.state !== "reserved") continue;
    if (inBox(p, vehicleBox(scene, v))) {
      return { kind: "vehicle", id: v.id, label: v.id,
               detail: `${v.user} · ${v.nodes} bay${v.nodes === 1 ? "" : "s"} · asked ${fmt(v.est)} · ${v.state}`,
               x: p.x, y: p.y };
    }
  }
  // bays
  for (const bay of scene.bays) {
    if (inBox(p, bayBox(scene, bay))) {
      const state = bay.occupiedBy ? `running: ${bay.occupiedBy}` : bay.idle ? "idle" : "free";
      return { kind: "bay", id: bay.id, label: bay.id,
               detail: `${bay.lot} lot · ${state}`, x: p.x, y: p.y };
    }
  }
  // neighbourhood rings
  for (const nb of scene.neighbourhoods) {
    const d = Math.hypot(p.x - nb.x, p.y - nb.y);
    if (d <= nb.r + 10) {
      return { kind: "neighbourhood", user: nb.user, label: nb.label,
               detail: `patience ${Math.round(nb.ring * 100)}%${nb.overflow ? " — overflowed" : ""}`,
               x: nb.x, y: nb.y - nb.r - 8 };
    }
  }
  // booth
  if (inBox(p, scene.booth)) {
    return { kind: "booth", label: "Dispatch booth",
             detail: scene.booth.staffed ? "staffed — running your rules" : "empty — traffic by hand",
             x: scene.booth.x, y: scene.booth.y };
  }
  // lots (background of bays)
  for (const lot of scene.lots) {
    if (inBox(p, lot)) return { kind: "lot", id: lot.id, label: `${lot.id} lot`, detail: lot.material, x: p.x, y: p.y };
  }
  return null;
}

/** Keyboard focus walk: stable order of all focusable entities (a11y path for the canvas). */
export function focusOrder(scene: CampusScene): Neighbourhood[] {
  return [...scene.neighbourhoods];
}

function fmt(t: number): string {
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  return `${(t / 3600).toFixed(1)}h`;
}

export type { Lot };
