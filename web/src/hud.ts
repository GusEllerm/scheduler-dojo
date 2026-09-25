/**
 * Stage 7 progression HUD: a belt chip (coloured per belt), the spendable credits count, and the
 * next-belt hint, mounted into the app header. Re-rendered from `progression.view()` (the engine
 * is the single source of truth), plus a small toast lane for "welcome back" drift grants.
 */

import * as progression from "./progression";
import type { ProgressionView } from "./bridge";

export interface HudOptions {
  /** Open the upgrade shop (wired by main.ts to the shop handle). */
  onOpenShop?: () => void;
}

export interface HudHandle {
  /** Re-read the progression view and repaint the HUD. */
  refresh(): Promise<void>;
  /** Show a transient toast (e.g. "welcome back +N credits"). */
  announce(message: string): void;
}

const BELT_CLASS = (belt: string): string => `belt-${belt.toLowerCase()}`;

export function mountHud(container: HTMLElement, options: HudOptions = {}): HudHandle {
  container.textContent = "";

  const root = document.createElement("div");
  root.className = "hud";

  const belt = document.createElement("span");
  belt.className = "hud-belt";
  belt.title = "belt — earned with lifetime credits";

  const credits = document.createElement("span");
  credits.className = "hud-credits";
  credits.title = "spendable credits (earn floor(score/10) per run)";

  const next = document.createElement("span");
  next.className = "hud-next";

  const shopButton = document.createElement("button");
  shopButton.type = "button";
  shopButton.className = "hud-shop-button";
  shopButton.textContent = "Upgrades";
  if (options.onOpenShop) shopButton.addEventListener("click", options.onOpenShop);

  root.append(belt, credits, next, shopButton);
  container.append(root);

  const toastHost = document.createElement("div");
  toastHost.className = "hud-toasts";
  document.body.append(toastHost);

  let toastTimer = 0;

  function paint(v: ProgressionView): void {
    belt.textContent = v.belt;
    belt.className = `hud-belt ${BELT_CLASS(v.belt)}`;
    credits.textContent = `${v.credits} cr`;
    next.textContent = v.next_belt ? `→ ${v.next_belt[0]} in ${v.next_belt[1]}` : "top belt";
  }

  async function refresh(): Promise<void> {
    paint(await progression.view());
  }

  function announce(message: string): void {
    const toast = document.createElement("div");
    toast.className = "hud-toast";
    toast.textContent = message;
    toastHost.replaceChildren(toast);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastHost.replaceChildren(), 6000);
  }

  void refresh().catch(() => undefined);
  return { refresh, announce };
}
