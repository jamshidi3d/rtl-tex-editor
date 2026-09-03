# Bidi LaTeX editor for VS Code — design notes

Working notes for a VS Code extension that would let you edit the Persian thesis
(`Thesis/PhDThesis.tex`, XeLaTeX + `xepersian`) with correct mixed-direction text
handling — Telegram-style — instead of fighting Monaco's bidi behaviour.

Distilled from the `/btw` discussion (2026-09).

---

## 1. The problem

Every line of the thesis mixes **RTL** Persian body text with **LTR** runs:
English terms, `\lr{}` / `\rl{}` / `\begin{latin}` wrappers, math, `\cite{}`,
URLs, numbers. What we want, per the Unicode Bidirectional Algorithm (UBA):

- base direction chosen **per paragraph** from content (auto), not per file;
- **visual** caret navigation — arrow keys and mouse clicks land where the glyph
  is, in reordered mixed runs;
- selection that spans reordered runs correctly.

VS Code / Monaco render the UBA per line but the **caret/selection/column math
assumes logical order == visual LTR**, so in mixed lines the cursor lands in the
wrong place on click and on arrow-key motion. There is no base-direction setting
and a long-standing open upstream feature request.

---

## 2. Why a normal extension can't fix rendering + caret

- The extension host has **no DOM access** to the editor.
- `TextEditorDecorationType.textDecoration` can smuggle CSS
  (`direction: rtl; unicode-bidi: bidi-override`) onto lines — a few published
  extensions do this — but:
  - `bidi-override` forces a **single** direction, so it can't reorder genuinely
    mixed runs;
  - it **does not fix the caret** — clicks and arrows still land wrong. This is
    the core unsolved issue and decorations cannot touch it.
- VS Code already runs the UBA per line and flags trojan-source bidi control
  chars, but exposes none of the machinery an extension would need.

---

## 3. Approaches, ranked

### A. Webview `CustomTextEditor` — the real fix

A full iframe you control; the **browser** does UBA *and* caret navigation
natively.

- **Editor component:** CodeMirror 6 (built-in bidi: visual-aware cursor motion,
  bidi spans) — recommended. Or a per-paragraph `contenteditable` /
  `<textarea dir="auto">` (simplest, but you lose highlighting / fine control).
- Set `dir="auto"` per logical paragraph so base direction follows content
  (heuristic caveats in §6).
- **Cost:** a parallel editor registered for `*.tex`; you must wire up
  completion, diagnostics, outline, SyncTeX, undo/redo, save yourself.
- Document sync webview ⇄ host `TextDocument` via `postMessage` + the
  `CustomTextEditor` edit API.

### B. Plain extension — editing aids only (no render fix)

Cheap, ships in days, removes most day-to-day friction while you keep using
normal VS Code:

- Command: wrap selection in bidi isolates **U+2066** LRI / **U+2067** RLI /
  **U+2069** PDI, or in `\lr{}` / `\rl{}`.
- Auto-insert **U+200E** LRM / **U+200F** RLM / **U+061C** ALM around number
  runs, punctuation, inline `$…$` / `\verb`, URLs.
- Direction-mismatch and stray-control-char linting (diagnostics).
- Snippets for `\begin{latin}…\end{latin}`, `\lr{}`, common wrappers.
- Optional line-level decoration to *visually* flip predominantly-RTL lines —
  with the explicit caveat that the caret will be off.

### C. Upstream Monaco / VS Code patch

The only way to fix the built-in editor itself. Large; must land in
`microsoft/vscode`. Track the existing feature request.

---

## 4. Completion — borrowing from the LaTeX ecosystem

Applies to approach **A** (approach B just reuses whatever the user installed).

### Tier 1 — spawn `texlab` (recommended)

`texlab` is the standalone Rust LaTeX language server that LaTeX Workshop itself
drives. It gives:

- command / environment completion;
- `\ref` / `\label` targets;
- **`\cite` keys read straight from `references.bib`**;
- package / class names, file-path completion;
- hover, document symbols, diagnostics.

Wiring: host spawns `texlab` as a child process, speaks LSP
(`vscode-languageclient` or raw JSON-RPC). Webview sends cursor position + text
over `postMessage`; host issues `textDocument/completion`; relays
`CompletionItem[]` back; CodeMirror's `@codemirror/autocomplete` async source
renders the popup. Feed `texlab` `textDocument/didChange` so its `\label` /
`\cite` indexes and diagnostics stay live.

### Tier 2 — `vscode.executeCompletionItemProvider`

From the host, call this built-in command with the doc URI + position; it runs
**every** registered provider for the `.tex` doc and returns a merged
`CompletionList` to forward to the webview. Needs a real `TextDocument` (a
`CustomTextEditor` has one). Plain snapshot, no streaming; lazy `documentation` /
`additionalTextEdits` need a follow-up `vscode.executeCompletionItemResolve`.
You inherit whatever the user has installed.

### Tier 3 — local snippet source (offline fallback)

Static list bundled in the webview: common commands / environments; macros
parsed from `notation.tex` on load; `.bib` keys scanned directly. Zero
dependency, but not context-aware (won't validate `\ref` targets or dedupe
against loaded packages).

### Suggested split

- `texlab` from the host for real completion + diagnostics + hover.
- Small local snippet source in the webview for project macros you parse yourself
  (`notation.tex`, custom `\newcommand`s).
- `texlab` is language intelligence only — SyncTeX and build orchestration stay
  in host code.

---

## 5. Compile / preview cycle (considered settled)

- Host shells out to the thesis's existing build:
  `latexmk -xelatex -shell-escape PhDThesis.tex`; watches for the PDF; shows it
  in a webview PDF viewer (pdf.js).
- Forward search: editor line → PDF page via `synctex view`.
- Reverse search: PDF click → `synctex edit` → host reveals the
  `CustomTextEditor` at that line.
- Debounce builds; parse the `.log` and surface `texlab` diagnostics inline.

---

## 6. Minimal build order (approach A)

1. `CustomTextEditor` shell for `*.tex` + CodeMirror 6 with `dir="auto"`
   paragraphs — get correct bidi **rendering + caret** first; nothing else
   matters until this feels right.
2. Document sync host ⇄ webview; undo/redo; save; external-edit reconciliation.
3. pdf.js preview panel + `latexmk` build command + SyncTeX both directions.
4. Spawn `texlab`; pipe completion + diagnostics + hover.
5. Local snippet source for `notation.tex` macros; bidi-isolate / `\lr{}`
   insertion commands (these are also worth shipping standalone as approach B).

---

## 7. Open questions / risks

- **Base-direction heuristic.** `dir="auto"` keys on the first *strong* char; a
  line starting `\section{` (LTR) then Persian guesses wrong. Likely need a
  first-strong-*letter* rule (skip `\`, `{`, digits, punctuation) or an explicit
  per-line marker.
- **Feature-parity gap.** Folding, multi-cursor, minimap, and every other
  extension you rely on are gone *inside* the `CustomTextEditor`.
- **Perf.** A webview editor on a large single-file thesis vs. native Monaco.
- **State consistency.** Keeping the host `TextDocument` and webview in sync
  under `git checkout`, format-on-save, etc.
- **`texlab` and bidi macros.** It won't give `\rl{}` / `\lr{}` /
  `\begin{latin}` any special treatment — mostly fine since its analysis is
  syntactic.
- **Scope.** This is a parallel editor for one file type; decide if that is
  worth it vs. approach B (editing aids) plus tolerating Monaco's caret for now.
