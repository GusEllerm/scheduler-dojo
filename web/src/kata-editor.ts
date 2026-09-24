/**
 * Stage 6: a CodeMirror 6 editor for the Kata language.
 *
 * The syntax-highlighting mode is generated from the lexer's vocabulary: the keyword list below is
 * a mirror of `KEYWORDS` in `src/scheduler_dojo/kata/lexer.py` (kept as a constant because the
 * bridge does not expose the lexer table — update BOTH when the language grows), and the builtin
 * names come from the tiers in `kata/spec.md` §6. `#` lines are a comment token.
 *
 * `showErrors(errors)` maps `check_kata` errors (1-based `line`) onto the document:
 *   - a red line background + squiggle (a `LineDecoration` per error line, CSS draws the squiggle),
 *   - a marker in a dedicated left gutter (hover it for the `code: message` text),
 *   - an inline `⚠ code: message` chip at the end of the offending line.
 * Any edit clears the marks (line numbers go stale the moment you type).
 */

import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  type DecorationSet,
  type GutterMarker as GutterMarkerType,
  gutter,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { StreamParser } from "@codemirror/language";

/** Mirror of `kata/lexer.py::KEYWORDS` — update BOTH when the language grows. */
const KATA_KEYWORDS: readonly string[] = [
  "order", "place", "preempt", "route",
  "by", "def",
  "if", "elif", "else",
  "for", "in", "while",
  "return", "pass", "remember",
  "not", "and", "or",
  "true", "false", "nil",
];

/** Builtin names from `kata/spec.md` §6 (by tier) — highlighted as calls. */
const KATA_BUILTINS: readonly string[] = [
  "queue", "running", "now", "nodes", "free_nodes", "fits_now", "fits_later", "place",
  "end_if_started_now", "first", "rest", "len", "min", "max", "sum", "sorted", "any", "all",
  "abs", "recall",
  "earliest_fit", "reserve", "reservation_start",
  "user_usage", "user_share",
  "est_runtime",
  "preempt", "route", "transfer_cost", "sites", "current_site",
];

const KEYWORDS = new Set(KATA_KEYWORDS);
const BUILTINS = new Set(KATA_BUILTINS);
const SLOTS = new Set(["order", "place", "preempt", "route"]);

// --- language (a stream grammar generated from the two tables above) -------------------

interface KataStreamState {
  inComment: boolean;
}

const kataParser: StreamParser<KataStreamState> = {
  name: "kata",
  tokenTable: {
    Keyword: t.keyword,
    Slot: t.definition(t.keyword),
    Builtin: t.function(t.variableName),
    Number: t.number,
    String: t.string,
    Comment: t.lineComment,
    Operator: t.operator,
    Punctuation: t.punctuation,
    Variable: t.variableName,
  },
  token(stream, state) {
    if (stream.sol()) state.inComment = false;
    if (!state.inComment && stream.eatSpace()) return null;
    if (state.inComment || stream.peek() === "#") {
      state.inComment = true;
      stream.skipToEnd();
      return "Comment";
    }
    const ch = stream.peek() ?? "";
    if (ch >= "0" && ch <= "9") {
      stream.match(/^\d[\d_]*(?:\.[\d_]+)?/);
      return "Number";
    }
    if (ch === '"') {
      stream.next();
      if (!stream.skipTo('"')) stream.skipToEnd();
      else stream.next();
      return "String";
    }
    if (/[A-Za-z_]/.test(ch)) {
      const word = String(stream.match(/^[A-Za-z_][A-Za-z0-9_]*/));
      if (KEYWORDS.has(word)) return SLOTS.has(word) ? "Slot" : "Keyword";
      if (BUILTINS.has(word)) return "Builtin";
      return "Variable";
    }
    if (stream.match("==") || stream.match("!=") || stream.match("<=") || stream.match(">=") || stream.match("//")) {
      return "Operator";
    }
    if ("+-*/%<>|=".includes(ch)) {
      stream.next();
      return "Operator";
    }
    if ("(),.:[]".includes(ch)) {
      stream.next();
      return "Punctuation";
    }
    stream.next(); // unknown character: consume so we always progress
    return null;
  },
  startState() {
    return { inComment: false };
  },
  languageData: {
    commentTokens: { line: "#" },
    indentUnit: "    ",
  },
};

const kataLanguage = StreamLanguage.define(kataParser);

const kataHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#c792ea" },
  { tag: t.definition(t.keyword), color: "#ffcb6b", fontWeight: "bold" },
  { tag: t.function(t.variableName), color: "#82aaff" },
  { tag: t.variableName, color: "#d6deeb" },
  { tag: t.number, color: "#f78c6c" },
  { tag: t.string, color: "#ecc48d" },
  { tag: t.lineComment, color: "#637777", fontStyle: "italic" },
  { tag: t.operator, color: "#89ddff" },
  { tag: t.punctuation, color: "#89ddff" },
]);

// --- error line decorations ------------------------------------------------------------

export interface KataErrorMark {
  code: string;
  message: string;
  /** 1-based line from `check_kata` (clamped to the document). */
  line?: number;
  col?: number;
}

const setMarks = StateEffect.define<readonly KataErrorMark[]>();

/** The `⚠ code: message` chip pinned to the end of an error line. */
class ErrorChip extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: ErrorChip): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "kata-err-chip";
    chip.textContent = `⚠ ${this.text}`;
    chip.title = this.text;
    return chip;
  }
}

/** The `●` mark in the error gutter. */
class ErrorGutterMark extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(other: ErrorGutterMark): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "kata-err-dot";
    dot.textContent = "●";
    if (!this.text.trim()) dot.style.visibility = "hidden"; // width spacer, not a real mark
    else dot.title = this.text;
    return dot;
  }
}

function buildDecorations(state: EditorState, marks: Map<number, string>): DecorationSet {
  if (!marks.size) return Decoration.set([]);
  const decos: { from: number; deco: ReturnType<typeof Decoration.line> | ReturnType<typeof Decoration.widget> }[] = [];
  const last = state.doc.lines;
  for (const [rawLine, text] of marks) {
    const lineNo = Math.min(Math.max(1, Math.round(rawLine)), last);
    const line = state.doc.line(lineNo);
    decos.push({ from: line.from, deco: Decoration.line({ class: "kata-err-line" }) });
    decos.push({ from: line.to, deco: Decoration.widget({ widget: new ErrorChip(text), side: 1 }) });
  }
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos.map((d) => d.deco.range(d.from)));
}

const markField = StateField.define<Map<number, string>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) {
        const next = new Map<number, string>();
        for (const mark of effect.value) {
          const line = Math.max(1, Math.round(mark.line ?? 1));
          const text = `${mark.code}: ${mark.message}`;
          next.set(line, next.has(line) ? `${next.get(line)} · ${text}` : text);
        }
        return next;
      }
    }
    // Edits invalidate line numbers: drop the marks rather than point at the wrong line.
    if (tr.docChanged && value.size) return new Map();
    return value;
  },
  provide: (field) => [
    EditorView.decorations.compute([field], (state) => buildDecorations(state, state.field(field))),
  ],
});

function errorGutter(): Extension {
  return gutter({
    class: "kata-err-gutter",
    lineMarker(view, line): GutterMarkerType | null {
      const text = view.state.field(markField).get(view.state.doc.lineAt(line.from).number);
      return text ? new ErrorGutterMark(text) : null;
    },
    initialSpacer: () => new ErrorGutterMark(" "),
  });
}

// --- the editor handle -----------------------------------------------------------------

export interface KataEditorHandle {
  readonly view: EditorView;
  getValue(): string;
  setValue(source: string): void;
  /** Paint `check_kata` errors: line background + squiggle + gutter mark + inline chip. */
  showErrors(errors: readonly KataErrorMark[]): void;
  clearErrors(): void;
  focus(): void;
  destroy(): void;
}

const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--text, #d6deeb)",
      backgroundColor: "#0d1219",
      fontSize: "13px",
      border: "1px solid var(--line, #27303e)",
      borderRadius: "8px",
      height: "100%",
    },
    "&.cm-focused": { outline: "1px solid var(--accent, #4f8ff7)" },
    ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.5" },
    ".cm-gutters": { backgroundColor: "#10161f", color: "#4b5769", border: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(79,143,247,0.07)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(79,143,247,0.12)", color: "#c3ccd9" },
    ".kata-err-gutter": { minWidth: "12px" },
    ".kata-err-dot": { color: "#ff5f56", fontWeight: "bold", paddingLeft: "2px" },
    ".kata-err-line": {
      backgroundColor: "rgba(255,95,86,0.10)",
      textDecoration: "underline wavy #ff5f56 1px",
      textUnderlineOffset: "3px",
    },
    ".kata-err-chip": {
      marginLeft: "14px",
      padding: "0 6px",
      borderRadius: "4px",
      fontSize: "11px",
      color: "#ffb4ad",
      backgroundColor: "rgba(255,95,86,0.16)",
      border: "1px solid rgba(255,95,86,0.4)",
      whiteSpace: "nowrap",
      fontStyle: "italic",
    },
  },
  { dark: true },
);

export function mountKataEditor(container: HTMLElement, initialValue = ""): KataEditorHandle {
  container.textContent = "";
  const mount = document.createElement("div");
  mount.className = "kata-editor";
  container.append(mount);

  const view = new EditorView({
    parent: mount,
    state: EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        errorGutter(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        kataLanguage,
        syntaxHighlighting(kataHighlight, { fallback: true }),
        markField,
        EditorView.lineWrapping,
        editorTheme,
      ],
    }),
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(source: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
        effects: setMarks.of([]),
      });
    },
    showErrors(errors) {
      view.dispatch({ effects: setMarks.of(errors.map((error) => ({ ...error }))) });
    },
    clearErrors() {
      view.dispatch({ effects: setMarks.of([]) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
