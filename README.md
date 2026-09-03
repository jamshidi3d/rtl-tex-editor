# RTL-Web-Editor

A local, single-purpose editor for the mixed **RTL/LTR** LaTeX of the thesis:
CodeMirror 5 taught **per-line base direction** — a non-command line containing
Persian is RTL (right-aligned, RTL bidi order, RTL caret motion); `\command`
lines, symbols and English stay LTR — plus a **live PDF** split view, a **folder
tree**, and **light/dark** syntax themes.

Architecture follows `bidi-extension.md` §3-A / §5: a tiny Node host
(`server.js`) does file I/O + `latexmk`; the browser (`public/`) is the editor.

---

## Run

Requires **Node ≥ 18** and **TeX Live** (`latexmk` on `PATH`).

### Windows — `rtl-editor.bat`

```bat
rtl-editor.bat                     ::  root = parent folder of the script
rtl-editor.bat  D:\papers\draft    ::  root = that folder
rtl-editor.bat  D:\papers\draft 5200   ::  ... on port 5200
```

Starts the server in its own window and opens the URL in your default browser.
You can also **drag a folder onto the .bat** to open the editor rooted there.
Env: `RWE_PORT`, `RWE_ENGINE` (`xelatex` | `pdflatex` | `lualatex`).

### Any OS — `node`

```sh
node RTL-WebEditor/server.js --root . --engine xelatex
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
| Scroll sync | **⇅ sync** links editor and preview scrolling. Markdown is two-way (anchored on each block's source line); PDF is editor → page only, via SyncTeX (the embedded PDF viewer reports no scroll position, so the reverse isn't possible). State is remembered. |
| Change workspace folder | 📁 in the tree header (or click the folder name) → browse / paste a path / pick a recent one. Disabled with `--lock-root`. |
| Save | `Ctrl/Cmd+S` (💾) — conflict-checked against disk mtime |
| Build | **Build ▶** or `Ctrl/Cmd+B` — saves the open file first, then runs `latexmk` |
| Pick the main `.tex` | the **main** dropdown, or the *main* badge on a `.tex` row (defaults to `PhDThesis.tex`) |
| Editor left / right of the PDF | **⇄ sides** |
| Light / dark | **☾ / ☀** |
| Text direction | **dir:** cycles `auto` (per line — a non-command line with Persian is RTL, everything else LTR; default) → `rtl` (force every line RTL) → `ltr` (force every line LTR). In `auto`, each line's bidi order, alignment and arrow-key motion follow its own base direction. Choice is remembered. |
| Accept a completion | **Tab** or click (Enter is always a newline) |
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
- **CodeMirror 5 (5.65.16) loads from cdnjs** via plain `<script>`/`<link>` tags
  in `index.html` — needs network on first load (then cached). To vendor for
  offline use, drop the pinned files into `public/vendor/` and repoint the tags.
- `server.js` runs `latexmk -shell-escape` and can read/write anywhere under
  `--root`. It binds to `127.0.0.1` only. Point `--root` at a folder you trust.
- Single-file editor: no folding-config, multi-cursor niceties, minimap, or
  other VS Code extensions inside this pane — by design (§7 of the doc).
- Files > 5 MB are not opened; aux files are hidden unless **aux** is ticked.
