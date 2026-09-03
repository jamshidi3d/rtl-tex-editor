# RTL TeX Editor

A local, single-purpose editor for mixed **RTL/LTR** TeX (a Persian thesis, in
particular): **CodeMirror 6** with **per-line base direction**
(`EditorView.perLineTextDirection`) — a non-command line containing Persian is
RTL (right-aligned, RTL caret motion, RTL selection); `\command` lines, symbols
and English stay LTR. On an RTL line, each `\command` / `$…$` / `{…}` run is
wrapped as an **LTR bidi isolate** (`bidiIsolate` + the `bidiIsolatedRanges`
facet), so inline commands and math read left-to-right *inside* the Persian
sentence, with the caret and selection staying correct — something CodeMirror 5
could not do. Plus a **live pdf.js preview** with **two-way SyncTeX** (caret ↔
page, click a paragraph → open the source), a **folder tree**, and
**light/dark** themes (incl. a dark PDF).

The editor is bundled locally (`public/editor/src/` → `public/editor/cm6.bundle.js`,
committed). To rebuild after changing it: `npm install && npm run build:editor`
(needs esbuild + the `@codemirror/*` packages from `devDependencies`). Running
the tool itself needs no `npm install`.

UI text is **DejaVu Sans**; Persian / RTL text is **IRANSansWeb**.

Architecture follows `bidi-extension.md` §3-A / §5: a tiny Node host
(`server.js`) does file I/O + `latexmk` + SyncTeX parsing; the browser
(`public/`) is the editor.

---

## Run

Requires **Node ≥ 18** and **TeX Live** (`latexmk` on `PATH`).

### Windows — `rtl-tex-editor.bat`

```bat
rtl-tex-editor.bat                       ::  root = parent folder of the script
rtl-tex-editor.bat  D:\papers\draft      ::  root = that folder
rtl-tex-editor.bat  D:\papers\draft 5200 ::  ... on port 5200
```

Starts the server in its own window and opens the URL in your default browser.
You can also **drag a folder onto the .bat**.

### Linux / macOS — `rtl-tex-editor.sh`

```sh
./rtl-tex-editor.sh                    #  root = parent folder of the script
./rtl-tex-editor.sh  ~/papers/draft    #  root = that folder
./rtl-tex-editor.sh  ~/papers/draft 5200
```

Runs the server in the foreground (Ctrl+C stops it) and opens the URL via
`open` (macOS) / `xdg-open` (Linux).

Both launchers honour `RWE_PORT` and `RWE_ENGINE` (`xelatex` | `pdflatex` |
`lualatex`).

### Any OS — `node`

```sh
node rtl-tex-editor/server.js --root . --engine xelatex
#   then open http://127.0.0.1:5199
```

Flags: `--root <dir>` (workspace, default = cwd) · `--port <n>` (default 5199) ·
`--engine xelatex|pdflatex|lualatex` · `--lock-root` (disable the in-UI folder
switch below).

---

## Use

| Action | How |
|---|---|
| Open a file | click it in the tree (left) |
| Preview pane | PDF viewer for `.tex` work; switches to a live **Markdown** viewer when a `.md` file is open (GFM tables, KaTeX `$…$` / `$$…$$` math, ` ```mermaid ` diagrams). **Build** switches it back to the PDF. |
| Scroll sync | **⇅ sync** links editor and preview. Markdown: two-way, eased, anchored on each block's source line. PDF: moving the caret or scrolling the editor reveals & highlights the spot in the PDF (forward SyncTeX); **clicking in the PDF** opens the matching source file at that line and flashes it (reverse SyncTeX). Multi-file (`\include` / `\input`) aware. State is remembered. |
| Change workspace folder | 📁 in the tree header (or click the folder name) → browse / paste a path / pick a recent one. Disabled with `--lock-root`. |
| Save | `Ctrl/Cmd+S` (💾) — conflict-checked against disk mtime |
| Build | **Build ▶** or `Ctrl/Cmd+B` — saves the open file first, then runs `latexmk` |
| Pick the main `.tex` | the **main** dropdown, or the *main* badge on a `.tex` row (defaults to `PhDThesis.tex`) |
| Editor left / right of the PDF | **⇄ sides** |
| Light / dark | **☾ / ☀** |
| PDF dark mode | **Alt+I** cycles `auto` (follows the app theme — dark app → inverted PDF) → `on` → `off`. Remembered. |
| Text direction | **dir:** cycles `auto` (per line — a non-command line with Persian is RTL, everything else LTR; default) → `rtl` (force every line RTL) → `ltr` (force every line LTR). In `auto`, each line's bidi order, alignment and arrow-key motion follow its own base direction. Choice is remembered. |
| Accept a completion | **Enter** / **Tab** / click while the popup is open (otherwise Enter is a newline) |
| Find in file | **Ctrl/Cmd+F** opens a search panel (Enter / Shift+Enter to step, Esc to close) |
| Resize | drag the bars between sidebar / editor / PDF |
| Build log | bar at the bottom (auto-opens on failure) |

Completion (local, from `bidi-extension.md` §4 tier 3): LaTeX commands +
environments, `\newcommand` / `\DeclareMathOperator` macros parsed from the open
file, and `\cite{…}` keys scanned from the first `references.bib` / `*.bib` in
the tree.

---

## Notes & limits

- **PDF pane** is rendered with **pdf.js** (pinned 3.11.174, the last classic-UMD
  build; lazy-loaded from cdnjs on first build). Fit-to-width, virtualized pages.
  The pdf.js web worker is re-served from `/api/pdfjs-worker` (fetched once from
  cdnjs, cached in memory) so it runs as a real worker, not the slow main-thread
  fallback. `↗` still opens the raw PDF in the browser's own viewer (print /
  download / find). SyncTeX parses the `.synctex.gz` that `latexmk -synctex=1`
  writes — no external `synctex` binary needed.
- **Markdown pane** renders with `marked` + `DOMPurify`, `KaTeX`, and `mermaid`,
  all loaded from cdnjs the first time a `.md` file is opened (mermaid is ~3 MB —
  fetched only if a diagram is present). Math is protected from the Markdown
  parser before rendering; code blocks are left untouched.
- **CodeMirror 6 is bundled locally** — `public/editor/src/index.js` is built
  with esbuild to `public/editor/cm6.bundle.js` (committed, ~370 KB), loaded by
  one plain `<script>` in `index.html`. No CDN, works offline. Rebuild with
  `npm install && npm run build:editor`. The bundle carries the stex mode
  (`@codemirror/legacy-modes`), autocomplete, search, and the RTL/bidi-isolate
  wiring; its theme + syntax colours are CSS-var driven so the light/dark toggle
  needs no reconfigure.
- **Fonts** (DejaVu Sans, IRANSansWeb) load from jsDelivr via `@font-face` in
  `styles.css`, `font-display: swap` — offline you just get the system fallback.
- `server.js` runs `latexmk -shell-escape` and can read/write anywhere under
  `--root`. It binds to `127.0.0.1` only. Point `--root` at a folder you trust.
- Single-file editor: no folding-config, multi-cursor niceties, minimap, or
  other VS Code extensions inside this pane — by design (§7 of the doc).
- Files > 5 MB are not opened; aux files are hidden unless **aux** is ticked.
