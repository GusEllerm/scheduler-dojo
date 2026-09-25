// GENERATED from web/tokens/palette.json by scripts/gen_tokens.mjs — do not edit.
// Canvas-side color table: read the live CSS custom properties so the campus canvas and the
// DOM share one source (Concepts/Art Direction.md).
export const TOKEN_ROLES = [
  "nb-1",
  "nb-2",
  "nb-3",
  "nb-4",
  "nb-5",
  "nb-6",
  "nb-7",
  "nb-8",
  "veh-queued",
  "veh-chosen",
  "veh-reserved",
  "veh-running",
  "veh-done",
  "veh-timeout",
  "veh-preempted",
  "veh-transfer",
  "bay-idle",
  "bay-default",
  "bay-gpu",
  "bay-himem",
  "bay-remote",
  "bay-wasted",
  "ok",
  "gold",
  "warn",
  "overflow",
  "clock",
  "week",
  "playhead"
] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export function readTokens(getComputedStyleFn = getComputedStyle): Record<string, string> {
  const s = getComputedStyleFn(document.documentElement);
  const out: Record<string, string> = {};
  for (const role of TOKEN_ROLES) out[role] = s.getPropertyValue(`--sd-${role}`).trim();
  return out;
}

export function tokensFromCanvas(getComputedStyleFn = getComputedStyle): Record<string, string> {
  return readTokens(getComputedStyleFn);
}
