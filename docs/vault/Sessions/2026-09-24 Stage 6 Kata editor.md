---
livedocs: snapshot
tags: [session]
---
# 2026-09-24 Stage 6 — Full kata play (editor)

## Goal

Let levels 3–5 be solved by *writing Kata*: a real editor with inline errors, a kata library, and
Check/Run/Step wired to the bridge so the language engine is playable in the browser.

## Built (builder, TypeScript only)

- `kata-editor.ts` — CodeMirror 6. The stream-highlighter keyword table is a documented mirror of
  `kata/lexer.py::KEYWORDS` (the bridge exposes no lexer-table call, so a drift in the lexer would
  only cost highlighting, never correctness); `#` comments, numbers, operators, slot emphasis.
- Errors: `check_kata` errors (each with a 1-based `line`) live in a `StateField<Map<line,…>>`; a
  `LineDecoration` (red background + wavy underline) + an end-of-line `⚠ code: message` widget + a
  hoverable gutter mark render them; edits clear stale marks; clicking a list row jumps the cursor.
- `library.ts` — starter + the four reference katas, lazy-fetched from `/levels/reference_katas/`;
  the level's own `reference_kata` preloads. `kata-play.ts` — Check (must pass) → Run → timeline +
  scorecard + `persistence.recordFinish`; Step advances per job boundary.
- `main.ts` adds a third mode "Write a kata" (levels 3–5; hand stays on 1–2, watch everywhere).

## Verification (screenshots)

Backfill kata on level 3 → **score 800, gold saved**, pass/gold bar past gold, timeline fully painted
(green done + orange timeout bars), trajectory hash matches the watch-mode reference run. A broken
kata (`place(nothere)`) shows a red line + `3: syntax — expected NAME 'by', got '('`. `tsc --noEmit`
clean. Belongs to [[Kata]] and [[Pyodide Bridge]]. Engine side was already shipped in Stage 2.
