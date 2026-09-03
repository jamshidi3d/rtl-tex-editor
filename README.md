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

- **PDF pane** = the browser's native PDF viewer in an `<iframe>`; it reloads
  after each successful build. No SyncTeX yet (see `bidi-extension.md` §5 for the
  `synctex view/edit` upgrade).
- **CodeMirror 5 (5.65.16) loads from cdnjs** via plain `<script>`/`<link>` tags
  in `index.html` — needs network on first load (then cached). To vendor for
  offline use, drop the pinned files into `public/vendor/` and repoint the tags.
- `server.js` runs `latexmk -shell-escape` and can read/write anywhere under
  `--root`. It binds to `127.0.0.1` only. Point `--root` at a folder you trust.
- Single-file editor: no folding-config, multi-cursor niceties, minimap, or
  other VS Code extensions inside this pane — by design (§7 of the doc).
- Files > 5 MB are not opened; aux files are hidden unless **aux** is ticked.
