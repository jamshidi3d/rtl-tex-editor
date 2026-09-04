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

A tiny Node host (`server.js`) does file I/O + `latexmk` + SyncTeX parsing; the
browser (`public/`) is the editor. Full design notes — the bidi problem, the
CodeMirror 6 wiring, every `/api/*` route, the SyncTeX maths — are in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Run

Requires **Node ≥ 18** (runtime only — no `npm install` to run the tool) and a
**TeX distribution** with `latexmk` on `PATH` (TeX Live, MiKTeX, or MacTeX).

### Installing Node

| Platform | Quickest way | Check |
|---|---|---|
| Windows | `winget install OpenJS.NodeJS.LTS` — or the installer from [nodejs.org](https://nodejs.org) | `node --version` |
| macOS | `brew install node` — or the installer from [nodejs.org](https://nodejs.org) | `node --version` |
| Linux | distro package if it ships ≥ 18 (`sudo apt install nodejs`, `sudo dnf install nodejs`, `sudo pacman -S nodejs`); otherwise [nodesource](https://github.com/nodesource/distributions) or [`nvm`](https://github.com/nvm-sh/nvm) (`nvm install --lts`) | `node --version` |

### The workspace root

Every entry point takes an optional **root** — the one folder the editor reads,
writes, builds, and shows in its file tree. `latexmk -shell-escape` runs inside
it and nothing outside it is touched, so point it at a project you trust. It is
the **first argument** to `rtl-tex-editor.bat` / `.sh` (or `--root` for `node`);
with no argument the launchers use the folder they sit in, and `node` uses the
current directory. You can also switch it later from the UI. An optional
**second argument** overrides the port (default 5199).

### Windows — `rtl-tex-editor.bat`

```bat
rtl-tex-editor.bat
rtl-tex-editor.bat  D:\papers\draft
rtl-tex-editor.bat  D:\papers\draft 5200
```

Starts the server in its own window and opens the URL in your default browser.
You can also **drag a folder onto the .bat**.

### Linux / macOS — `rtl-tex-editor.sh`

```sh
./rtl-tex-editor.sh
./rtl-tex-editor.sh  ~/papers/draft
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

Flags: `--root <dir>` (the workspace root, above; default = current dir) ·
`--port <n>` (default 5199) · `--engine xelatex|pdflatex|lualatex` ·
`--lock-root` (disable the in-UI folder switch below).

---

## Use

**First run.** Point the launcher (or `--root`) at the folder that holds your
project. Pick the root `.tex` in the **main** dropdown (it guesses a `main.tex` /
`thesis.tex`, otherwise the first `.tex` it finds). Click a file in the tree to
open it, hit **Build ▶**, and the PDF appears on the right.

### Editing mixed RTL / LTR text

The **dir:** button cycles three modes (remembered):

- **auto** *(default)* — each line gets its own base direction. A line that
  contains Persian and isn't a `\command` line is **RTL**: right-aligned, RTL
  caret motion, RTL selection. `\section{…}` lines, blank lines, and pure
  Latin/punctuation stay **LTR**. On an RTL line, every `\command`, `$…$` and
  `{…}` run still reads **left-to-right** in place — inline math and commands are
  not mirrored — and selection / arrow keys behave normally across them.
- **rtl** — force every line right-to-left.
- **ltr** — force every line left-to-right (plain code-editor behaviour).

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl/Cmd+S` | save (conflict-checked against the file's mtime on disk) |
| `Ctrl/Cmd+B` | build (saves the open file first) |
| `Ctrl+Space` | completion popup |
| `Enter` / `Tab` | accept the highlighted completion (otherwise `Enter` = newline) |
| `Tab` / `Shift+Tab` | indent / dedent (or insert two spaces with no selection) |
| `Ctrl/Cmd+F` | find panel — `Enter` / `Shift+Enter` step, `Esc` closes |
| `Alt+I` | cycle PDF dark mode (`auto` → `on` → `off`) |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |

### Everything else

| Action | How |
|---|---|
| Open a file | click it in the tree (left) |
| New file / folder | right-click a folder (or empty space in the tree, for the workspace root) |
| Rename, duplicate, delete | right-click a file or folder |
| Change workspace folder | 📁 in the tree header (or click the folder name) → browse / paste a path / pick a recent one. Disabled with `--lock-root`. |
| Pick the main `.tex` | the **main** dropdown, or the *main* badge on a `.tex` row (guesses `main.tex` / `thesis.tex`, else the first `.tex`) |
| Show `.aux` / log files | tick **aux** in the tree header |
| Editor left / right of the PDF | **⇄ sides** |
| Light / dark | **☾ / ☀** |
| Open the raw PDF | **↗** in the preview header (browser's own viewer — print / download / find) |
| Resize panes | drag the bars between sidebar / editor / PDF |
| Build log | bar at the bottom (auto-opens on a failed build) |

**Completion** (`Ctrl+Space`) is local: LaTeX commands + environments, any
`\newcommand` / `\DeclareMathOperator` macros in the open file, and `\cite{…}`
keys from the first `references.bib` / `*.bib` in the tree. Accepting an
environment drops in the whole `\begin…\end` block with the caret on an indented
body line (list environments prefill `\item`); accepting an argument-taking
command (`\section`, `\ref`, `\textbf`, `\frac`, …) drops in its braces with the
caret inside.

**Scroll sync** (**⇅**) links editor and preview. Markdown: two-way, eased,
anchored on each block's source line. PDF: moving the caret or scrolling the
editor reveals and highlights the spot in the PDF (forward SyncTeX); **clicking
in the PDF** opens the matching source file at that line and flashes it (reverse
SyncTeX). Multi-file (`\include` / `\input`) aware. State is remembered.

The **preview pane** is the PDF viewer for `.tex` work and switches to a live
**Markdown** viewer (GFM tables, KaTeX `$…$` / `$$…$$` math, ` ```mermaid `
diagrams) when a `.md` file is open; **Build** switches it back.

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
- **CodeMirror 6 is bundled locally** — `public/editor/src/index.js` → esbuild →
  `public/editor/cm6.bundle.js` (committed, ~360 KB), one plain `<script>`. No
  CDN, works offline. Per-line base direction (`EditorView.perLineTextDirection`)
  + LTR bidi isolates (`bidiIsolate` / `bidiIsolatedRanges`) give inline
  commands and math that read left-to-right inside RTL lines with selection
  intact — see [`ARCHITECTURE.md`](ARCHITECTURE.md) §2, §7. Rebuild with
  `npm install && npm run build:editor`; running the tool needs no `npm install`.
- **Fonts** (DejaVu Sans, IRANSansWeb) load from jsDelivr via `@font-face` in
  `styles.css`, `font-display: swap` — offline you just get the system fallback.
- `server.js` runs `latexmk -shell-escape` and can read/write anywhere under
  `--root`. It binds to `127.0.0.1` only. Point `--root` at a folder you trust.
- Single-file editor: no code folding, multi-cursor visuals, or minimap — by
  design. Files > 5 MB are not opened; `.aux` / log files are hidden unless
  **aux** is ticked.
