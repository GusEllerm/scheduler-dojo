/**
 * The welcome card (Art 8, brief §9: "a fresh playtester reaches city 3 with no instructions").
 * A save with NO prefs and NO progression gets ONE calm card at first load — what the campus
 * is, and two doors: the guided city-1 script, or a quiet walk through the live campus. The
 * card deliberately teaches nothing the city-1 tutorial does not teach better in place: it is a
 * doorway, not a manual (the manual is the help drawer, `web/src/help.ts`).
 *
 * Like every panel here it is a labelled `role="dialog"`, focus-trapped by the shared
 * `trapDialog` (Escape closes; the global topmost-Escape reaches it too), and it carries no
 * motion of its own — under `prefers-reduced-motion` the global CSS block already zeroes
 * transitions, so the card simply appears ([[Accessibility]] rules 5 and 7).
 */

import { trapDialog } from "./booth";

export interface WelcomeOptions {
  host?: HTMLElement;
  /** the campaign door: city 1, hand traffic, its script attached (the existing chain path) */
  onStartCity: () => void;
  /** the calm door: the live campus, traffic driving itself */
  onWalk: () => void;
}

export interface WelcomeHandle {
  close(): void;
}

export function openWelcome(opts: WelcomeOptions): WelcomeHandle {
  const overlay = document.createElement("div");
  overlay.className = "callout-overlay welcome-overlay";
  overlay.style.position = "fixed";
  const panel = document.createElement("section");
  panel.className = "callout-panel welcome-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "welcome-title");
  const title = document.createElement("h3");
  title.id = "welcome-title";
  title.textContent = "Scheduler Dojo";
  const line = document.createElement("p");
  line.textContent = "A campus is a computer\u2019s job queue: neighbourhoods are people, "
    + "vehicles are jobs, bays are machines \u2014 and the dispatch booth is the rules that pick "
    + "who parks next.";
  const actions = document.createElement("div");
  actions.className = "callout-actions";
  const city = document.createElement("button");
  city.type = "button";
  city.textContent = "Start city 1 \u25b8";
  city.title = "the guided first city \u2014 it teaches as you play";
  const walk = document.createElement("button");
  walk.type = "button";
  walk.textContent = "Take a walk";
  walk.title = "watch the live campus drift by \u2014 nothing to do, just look";
  actions.append(city, walk);
  panel.append(title, line, actions);
  overlay.append(panel);
  (opts.host ?? document.body).append(overlay);

  const previously = document.activeElement as HTMLElement | null;
  let open = true;
  const dismiss = (): void => {
    if (!open) return;
    open = false;
    overlay.remove();
    previously?.focus?.();
  };
  city.addEventListener("click", () => {
    dismiss();
    opts.onStartCity();
  });
  walk.addEventListener("click", () => {
    dismiss();
    opts.onWalk();
  });
  city.focus();
  trapDialog(panel, dismiss);
  return { close: dismiss };
}
