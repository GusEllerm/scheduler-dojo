// campus-perf.ts — offline render-loop timing for the campus renderer.
// Pure rAF-less loop: the caller owns the browser clock; this only measures `render` calls.
// Deterministic scene cycling (scenes[f % scenes.length]); prev = the previous frame's scene so
// the interpolation path is exercised. Returns milliseconds per frame; the CALLER logs it.

import type { CampusScene } from "./campus";
import type { CampusRenderer } from "./campus-render";

export interface BenchResult {
  msPerFrame: number;
  frames: number;
}

export function benchRender(renderer: CampusRenderer, scenes: CampusScene[], frames: number): BenchResult {
  const n = Math.max(0, Math.floor(frames));
  if (!scenes.length || n === 0) return { msPerFrame: 0, frames: n };
  let prev: CampusScene | null = null;
  const t0 = performance.now();
  for (let f = 0; f < n; f++) {
    const scene = scenes[f % scenes.length]!;
    renderer.render(scene, prev, 1);           // progress 1 = settled frames (no half-lerps)
    prev = scene;
  }
  const t1 = performance.now();
  return { msPerFrame: (t1 - t0) / n, frames: n };
}
