/**
 * Stage 7 progression store: the client owns a *persisted* engine-shaped state
 * (`{version, credits, lifetime, levels, upgrades, last_seen}` — see `scheduler_dojo.progression`)
 * inside the localStorage document, and every rule lives Python-side. The four wrappers below
 * (`view`, `complete`, `buy`, `drift`) call the bridge with the current state, persist the NEW
 * state the engine returns, and hand it back — the UI never computes credits itself.
 */

import { bridge, type ProgressionState, type ProgressionView } from "./bridge";
import { load, save } from "./persistence";

/** Unix seconds, as the engine's `last_seen`/drift clock expects. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** The saved progression state, or null when the player has none yet. */
export function getProgression(): ProgressionState | null {
  const doc = load() as { progression?: unknown };
  const p = doc.progression;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const state = p as ProgressionState;
  return typeof state.credits === "number" ? state : null;
}

/** Replace the saved progression state (the engine's returned state is authoritative). */
export function setProgression(state: ProgressionState): void {
  save({ progression: state as unknown as Record<string, unknown> });
}

/** A fresh v1 state (mirror of `progression.new_state`) stamped `now` so drift starts clean. */
function fresh(now: number): ProgressionState {
  return { version: 1, credits: 0, lifetime: 0, levels: {}, upgrades: [], last_seen: now };
}

/** Read-only HUD snapshot (belt, credits, next belt, upgrades + unlocked tiers). */
export async function view(): Promise<ProgressionView> {
  return bridge.progressionView(getProgression(), nowSec());
}

/** Record a finished run; returns the new state (credits in `_last_award`). */
export async function complete(levelId: string, score: number, seed: number): Promise<ProgressionState> {
  const state = await bridge.progressionCompletion(getProgression(), levelId, score, seed);
  setProgression(state);
  return state;
}

/** Has `seed` already been completed on `levelId`? Used to stop auto watch runs farming credits. */
export function hasPass(levelId: string, seed: number): boolean {
  return getProgression()?.levels[levelId]?.passes?.includes(seed) ?? false;
}

/** Buy an upgrade (the engine raises unless `buyable` — check `view()` first). */
export async function buy(upgradeId: string): Promise<ProgressionState> {
  const state = await bridge.progressionBuy(getProgression(), upgradeId);
  setProgression(state);
  return state;
}

/**
 * Art 6: the tutorial's FREE guided-first-use grant (`offer_upgrade {forced: id}`). Ownership
 * moves, credits never do — the engine's `progression_grant` is the rule; we persist its result.
 */
export async function grant(
  upgradeId: string,
): Promise<{ state: ProgressionState; ok: boolean; reason: string }> {
  const res = await bridge.progressionGrant(getProgression(), upgradeId);
  setProgression(res.state);
  return res;
}

/**
 * Art 6: take a week-end OFFER (free — §5.8). The engine refuses ids that boundary never offered
 * (`not_offered`) or a week that already accepted (`accepted`); the returned state persists.
 */
export async function acceptOffer(
  city: number, week: number, upgradeId: string,
): Promise<{ state: ProgressionState; ok: boolean; reason: string }> {
  const res = await bridge.offerAccept(getProgression(), city, week, upgradeId);
  setProgression(res.state);
  return res;
}

/**
 * Offline "welcome back" credits since `last_seen` (capped at 12h by the engine). On the very
 * first boot there is no state: stamp `last_seen = now` so a new player gets no free drift.
 */
export async function drift(now = nowSec()): Promise<{ state: ProgressionState; award: number }> {
  const saved = getProgression();
  const state = await bridge.progressionDrift(saved ?? fresh(now), now);
  setProgression(state);
  return { state, award: state._drift_award ?? 0 };
}
