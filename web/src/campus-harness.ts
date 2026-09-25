// Harness page (visual regression, Art 3): boots one campus run in manual mode and exposes
//   window.__dojoCampus = { ready: boolean, seekRender(t): Promise<void>, done: boolean }
// Query: ?level=level3&policy=shortest_first&kata=<text, optional>&w=1600&h=736
import type { Level } from "./bridge";
import { CampusPlay } from "./campus-play";

const params = new URLSearchParams(location.search);
const levelId = params.get("level") ?? "level1";
const policy = params.get("policy") ?? "fifo";
const kata = params.get("kata");
const w = Number(params.get("w") ?? 1600);

export interface CampusHarness {
  ready: boolean;
  done: boolean;
  seekRender: (t: number) => Promise<void>;
  fps: () => number;
}

declare global {
  interface Window { __dojoCampus?: CampusHarness }
}

async function main(): Promise<void> {
  const response = await fetch(new URL(`levels/${levelId}.json`, document.baseURI).href);
  const level = (await response.json()) as Level;
  const stage = document.getElementById("stage")!;
  stage.style.width = `${w}px`;
  const play = await CampusPlay.create({
    level, container: stage, manual: true, policy,
    reducedMotion: params.get("motion") !== "full",  // settled frames by default; ?motion=full animates
    kata: kata ?? undefined,
    onFinish: () => { (window.__dojoCampus as CampusHarness).done = true; },
  });
  window.__dojoCampus = { ready: true, done: false, seekRender: (t) => play.seekRender(t),
                           fps: () => play.fps() };
}

void main();
