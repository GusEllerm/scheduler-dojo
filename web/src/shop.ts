/**
 * Stage 7 upgrade shop: a modal listing the five upgrades as cards (name, cost, the kata tier it
 * unlocks, prerequisites, owned/buyable/locked). Buy state comes from `progression.view()` — the
 * engine's `buyable` flag decides, the UI only mirrors it. Cards call `progression.buy(id)`,
 * then notify via `onChange` so main.ts repaints the HUD and re-gates the kata unlocks.
 */

import * as progression from "./progression";
import type { ProgressionView, UpgradeInfo } from "./bridge";

export interface ShopOptions {
  /** Called after a successful purchase (main refreshes the HUD + level unlocks). */
  onChange?: () => void;
}

export interface ShopHandle {
  open(): void;
  close(): void;
  /** Re-read the view and repaint the cards. */
  refresh(): Promise<void>;
}

/** UI copy for the engine's upgrade ids (the engine owns cost/requires/unlocks). */
const COPY: Record<string, { name: string; blurb: string }> = {
  reserve: { name: "Reservations", blurb: "Reserve node sets and replay the clock — opens the `reserve` kata tier." },
  sensors: { name: "Sensors", blurb: "Job estimates become observable — opens the `sensor` kata tier." },
  fairness: { name: "Fairness", blurb: "Per-user service accounting — opens the `fairness` kata tier. Needs Reservations." },
  preempt: { name: "Preemption", blurb: "Suspend and resume jobs — opens the `preempt` kata tier. Needs Reservations." },
  route: { name: "Routing", blurb: "Place across sites, not just nodes — opens the `route` kata tier. Needs Fairness." },
};

const ORDER = ["reserve", "sensors", "fairness", "preempt", "route"];

export function mountShop(options: ShopOptions = {}): ShopHandle {
  const overlay = document.createElement("div");
  overlay.className = "shop-overlay";
  overlay.hidden = true;

  const panel = document.createElement("section");
  panel.className = "shop-panel";
  const head = document.createElement("div");
  head.className = "shop-head";
  const title = document.createElement("h2");
  title.textContent = "Upgrade shop";
  const purse = document.createElement("span");
  purse.className = "shop-purse";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "shop-close";
  close.textContent = "×";
  close.addEventListener("click", () => handle.close());
  head.append(title, purse, close);

  const grid = document.createElement("div");
  grid.className = "shop-grid";
  panel.append(head, grid);
  overlay.append(panel);
  document.body.append(overlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) handle.close();
  });

  let lastView: ProgressionView | null = null;
  let errorLine = "";

  let credits = 0;

  function statusText(info: UpgradeInfo): { text: string; kind: string } {
    if (info.owned) return { text: "owned", kind: "owned" };
    const missing = missingPrereq(info);
    if (missing.length) return { text: `needs ${missing.join(", ")}`, kind: "locked" };
    if (info.buyable) return { text: "buyable", kind: "buyable" };
    return { text: `need ${info.cost - credits} more credits`, kind: "poor" };
  }

  function missingPrereq(info: UpgradeInfo): string[] {
    const owned = new Set(lastView ? Object.entries(lastView.upgrades).filter(([, u]) => u.owned).map(([id]) => id) : []);
    return info.requires.filter((r) => !owned.has(r));
  }

  function paint(): void {
    if (!lastView) return;
    credits = lastView.credits;
    purse.textContent = `${credits} credits`;
    const cards: HTMLElement[] = ORDER.flatMap((id) => {
      const info = lastView?.upgrades[id];
      if (!info) return [];
      const copy = COPY[id] ?? { name: id, blurb: "" };
      const card = document.createElement("div");
      const status = statusText(info);
      card.className = `shop-card ${status.kind}`;

      const name = document.createElement("h3");
      name.textContent = copy.name;
      const cost = document.createElement("span");
      cost.className = "shop-cost";
      cost.textContent = `${info.cost} cr`;
      const blurb = document.createElement("p");
      blurb.className = "shop-blurb";
      blurb.textContent = copy.blurb;
      const tier = document.createElement("span");
      tier.className = "shop-tier";
      tier.textContent = `unlocks tier: ${info.unlocks.join(", ")}`;
      const state = document.createElement("span");
      state.className = `shop-state ${status.kind}`;
      state.textContent = status.text;

      const buyButton = document.createElement("button");
      buyButton.type = "button";
      buyButton.className = "shop-buy";
      buyButton.textContent = info.owned ? "Owned" : "Buy";
      buyButton.disabled = !info.buyable;
      buyButton.addEventListener("click", () => void buyNow(id));

      card.append(name, cost, blurb, tier, state, buyButton);
      return card;
    });
    grid.replaceChildren(...cards);
    if (errorLine) {
      const line = document.createElement("div");
      line.className = "shop-error";
      line.textContent = errorLine;
      grid.append(line);
    }
  }

  async function refresh(): Promise<void> {
    try {
      lastView = await progression.view();
      errorLine = "";
    } catch (error) {
      errorLine = String(error);
    }
    paint();
  }

  async function buyNow(id: string): Promise<void> {
    if (!lastView?.upgrades[id]?.buyable) return; // the engine raises otherwise — mirror buyable
    try {
      await progression.buy(id);
      await refresh();
      options.onChange?.();
    } catch (error) {
      errorLine = `cannot buy: ${error instanceof Error ? error.message : String(error)}`;
      paint();
    }
  }

  const handle: ShopHandle = {
    open() {
      overlay.hidden = false;
      void refresh();
    },
    close() {
      overlay.hidden = true;
    },
    refresh,
  };
  return handle;
}
