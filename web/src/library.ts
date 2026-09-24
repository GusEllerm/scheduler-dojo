/**
 * Stage 6: the in-game kata library — the repo's reference katas plus a starter skeleton.
 *
 * The reference texts are loaded lazily over HTTP from the dev server: the vite config serves the
 * repo `levels/` tree at `/levels/…` (see `web/vite.config.ts::serveLevels`), so each entry is just
 * a path like `reference_katas/backfill.kata`. Fetches are cached in-module, so selecting the same
 * kata twice is free. The starter skeleton is inline (it is teaching text, not an engine golden).
 */

export interface KataEntry {
  /** Shown in the library list. */
  name: string;
  /** One-line teaching blurb. */
  blurb: string;
  /** Path under `/levels/` to fetch (mutually exclusive with `text`). */
  path?: string;
  /** Inline source (the starter skeleton). */
  text?: string;
}

export const KATA_STARTER = `# Starter kata: FIFO order + first-fit placement — the engine's default, spelled out.
# Edit it, press Check (errors light up inline), then Run.

order by fifo_like:
    key = (job.submit_time, job.id)

place by first_fit:
    for j in queue():
        if fits_now(j):
            place(j)
        elif fits_later(j):
            break
`;

/** Everything the library lists, in order (starter first). */
export const KATA_LIBRARY: readonly KataEntry[] = [
  {
    name: "starter",
    blurb: "skeleton: FIFO order + first-fit place — edit me",
    text: KATA_STARTER,
  },
  {
    name: "shortest_first",
    blurb: "Level 2 — shortest walltime first crushes slowdown",
    path: "reference_katas/shortest_first.kata",
  },
  {
    name: "backfill",
    blurb: "Level 3 — gap-fill around the big job that never starts",
    path: "reference_katas/backfill.kata",
  },
  {
    name: "estimate_first",
    blurb: "Level 4 — order by the sensor estimate, not padded walltime",
    path: "reference_katas/estimate_first.kata",
  },
  {
    name: "fair_order",
    blurb: "Level 5 — least-served users first (Jain fairness)",
    path: "reference_katas/fair_order.kata",
  },
];

const cache = new Map<string, string>();

/** Load the kata text for a library entry (fetch-once, then cached). */
export async function loadKataText(entry: KataEntry): Promise<string> {
  if (entry.text !== undefined) return entry.text;
  const path = entry.path ?? "";
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const url = new URL(`/levels/${path}`, document.baseURI).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  cache.set(path, text);
  return text;
}

/** Build the clickable library list into `container`; `onSelect` fires per click. */
export function mountKataLibrary(
  container: HTMLElement,
  onSelect: (entry: KataEntry) => void,
): void {
  container.textContent = "";
  const heading = document.createElement("h3");
  heading.textContent = "Kata library";
  container.append(heading);
  for (const entry of KATA_LIBRARY) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "kata-lib-item";
    const name = document.createElement("b");
    name.textContent = entry.name;
    const blurb = document.createElement("span");
    blurb.textContent = entry.blurb;
    item.append(name, blurb);
    item.addEventListener("click", () => onSelect(entry));
    container.append(item);
  }
}
