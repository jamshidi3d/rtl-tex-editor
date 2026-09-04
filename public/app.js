/* RTL TeX Editor — browser front-end.
 * CodeMirror 6 editor (bundled at editor/cm6.bundle.js -> window.RTLCM) with
 * native per-line RTL/LTR direction and LTR bidi isolates for inline
 * \commands / $…$ / {…}, stex syntax highlighting, a live pdf.js preview with
 * two-way SyncTeX, a folder tree + folder switcher. Talks to server.js over
 * /api/*.
 */
(function () {
'use strict';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem('rwe.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('rwe.' + k, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------------ word lists
const LATEX_CMDS = ['\\section', '\\subsection', '\\subsubsection', '\\chapter', '\\part', '\\paragraph',
  '\\begin', '\\end', '\\item', '\\textbf', '\\textit', '\\emph', '\\texttt', '\\underline',
  '\\label', '\\ref', '\\eqref', '\\pageref', '\\autoref', '\\cite', '\\citep', '\\citet',
  '\\parencite', '\\textcite', '\\nocite', '\\footnote', '\\caption', '\\includegraphics',
  '\\usepackage', '\\newcommand', '\\renewcommand', '\\DeclareMathOperator', '\\input', '\\include',
  '\\left', '\\right', '\\frac', '\\sqrt', '\\sum', '\\int', '\\prod', '\\lim', '\\partial', '\\nabla',
  '\\infty', '\\langle', '\\rangle', '\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\theta',
  '\\lambda', '\\mu', '\\nu', '\\pi', '\\rho', '\\sigma', '\\phi', '\\varphi', '\\omega',
  '\\Delta', '\\Lambda', '\\Sigma', '\\Omega', '\\ell', '\\hat', '\\bar', '\\tilde', '\\vec',
  '\\lr', '\\rl', '\\noindent', '\\vspace', '\\hspace', '\\centering', '\\newpage', '\\cleardoublepage'];
const LATEX_ENVS = ['equation', 'equation*', 'align', 'align*', 'gather', 'itemize', 'enumerate',
  'description', 'figure', 'table', 'tabular', 'center', 'quote', 'quotation', 'verbatim',
  'latin', 'persian', 'matrix', 'bmatrix', 'pmatrix', 'vmatrix', 'cases', 'split', 'proof', 'abstract'];
// commands (name without backslash) whose completion should drop in a `{}` and
// put the caret inside it; `frac` gets `{}{}`.
const ARG_CMDS = new Set(['section', 'subsection', 'subsubsection', 'chapter', 'part', 'paragraph',
  'textbf', 'textit', 'emph', 'texttt', 'underline', 'label', 'ref', 'eqref', 'pageref', 'autoref',
  'cite', 'citep', 'citet', 'parencite', 'textcite', 'nocite', 'footnote', 'caption', 'includegraphics',
  'usepackage', 'input', 'include', 'lr', 'rl', 'hat', 'bar', 'tilde', 'vec', 'sqrt', 'frac']);
let BIB_KEYS = [];

function collectMacros(text) {
  const out = new Set();
  const re = /\\(?:re)?newcommand\*?\s*\{?\s*\\([a-zA-Z@]+)|\\DeclareMathOperator\*?\s*\{\s*\\([a-zA-Z@]+)/g;
  let m;
  while ((m = re.exec(text))) out.add('\\' + (m[1] || m[2]));
  return [...out];
}

// ------------------------------------------------------------------ editor
// The editor is CodeMirror 6, assembled in editor/cm6.bundle.js (window.RTLCM).
// `ed` is the handle it returns; `view` is the raw EditorView. CM6 does
// per-line base direction natively and lets the bundle mark \command / $…$ /
// {…} runs on RTL lines as LTR bidi isolates, so they read left-to-right while
// the Persian sentence around them still reads RTL — caret and selection stay
// correct. The helpers below bridge CM5-style {line,ch} <-> CM6 offsets for the
// sync + reverse-SyncTeX code further down.
let ed = null;
let view = null;

const docText = () => view.state.doc.toString();
function offAt(line, ch) {
  const d = view.state.doc;
  const L = d.line(Math.max(1, Math.min(d.lines, (line | 0) + 1)));
  return Math.max(L.from, Math.min(L.to, L.from + (ch | 0)));
}
function posAt(off) {
  const L = view.state.doc.lineAt(off);
  return { line: L.number - 1, ch: off - L.from };
}
function setCaret(line, ch) {
  view.dispatch({ selection: { anchor: offAt(line, ch || 0) }, scrollIntoView: true });
}
const edScroll = () => {
  const s = view.scrollDOM;
  return { top: s.scrollTop, height: s.scrollHeight, clientHeight: s.clientHeight };
};
const edHeightAtLine = (n) => view.lineBlockAt(offAt(n, 0)).top;

// A line's base direction is RTL only when it is a non-command line that carries
// at least one RTL (Persian/Arabic) character. Everything else is LTR: command
// lines (\section, \begin, …), empty lines, pure punctuation / braces / digits
// / Latin. Handed to the bundle, where it drives the per-line `.cm-rtl-line`
// class (direction + alignment, read back by perLineTextDirection) and which
// lines get LTR bidi isolates.
const CMD_LINE_RE = /^\s*\\/;
const HAS_FA_RE = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
function lineIsRtl(s) {
  return HAS_FA_RE.test(s) && !CMD_LINE_RE.test(s);
}

// dir toggle: auto (per line) / rtl (all right) / ltr (all left).
function applyDir() {
  if (ed) ed.setDir(LS.get('dir', 'auto'));
}

function initEditor() {
  ed = RTLCM.create({
    parent: $('#editor'),
    doc: '% open a file from the tree\n',
    lineIsRtl,
    words: { LATEX_CMDS, LATEX_ENVS, ARG_CMDS, collectMacros, getBibKeys: () => BIB_KEYS },
    on: {
      save: () => saveFile(),
      build: () => build(),
      docChange: () => { setDirty(isDirty()); if (previewMode === 'md') scheduleMd(); },
      selChange: () => onCaretActivity(),
      scroll: rafThrottle(() => syncFromEditor()),
    },
  });
  view = ed.view;
  applyDir();

  tw.preview = makePaneTween('preview', () => $('#mdView').scrollTop, (y) => { $('#mdView').scrollTop = y; });
  tw.editor = makePaneTween('editor', () => view.scrollDOM.scrollTop, (y) => { view.scrollDOM.scrollTop = y; });
  $('#mdView').addEventListener('scroll', rafThrottle(mdSyncFromPreview));
  // a genuine fast user scroll should stop the incoming glide, not be mistaken for it
  const stopIn = (el, pane) => ['wheel', 'pointerdown', 'keydown'].forEach(
    (evn) => el.addEventListener(evn, () => tw[pane].cancel(), { passive: true }));
  stopIn($('#mdView'), 'preview');
  stopIn(view.scrollDOM, 'editor');
}
function refreshCM() { if (ed) setTimeout(() => ed.refresh(), 20); }

// ------------------------------------------------------------------ file state
let curf = { path: null, mtimeMs: 0, saved: '' };
const setDirty = (d) => app.classList.toggle('dirty', !!d);
const isDirty = () => !!(view && curf.path && docText() !== curf.saved);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok && !(body && body.conflict)) throw new Error((body && body.error) || r.statusText);
  return { status: r.status, body };
}

async function openFile(rel) {
  if (isDirty() && !confirm('Discard unsaved changes in ' + curf.path + '?')) return;
  const { body } = await api('/api/file?path=' + encodeURIComponent(rel));
  curf = { path: rel, mtimeMs: body.mtimeMs, saved: body.content };
  ed.setDoc(body.content);   // rebuilds the state -> also clears history
  setCaret(0, 0);
  applyDir();                // re-assert dir mode (setDoc resets to 'auto')
  view.focus();
  setDirty(false);
  $('#fileName').textContent = rel;
  LS.set('lastFile', rel);
  markActiveInTree(rel);
  if (/\.bib$/i.test(rel)) refreshBibKeys(body.content);
  if (MD_RE.test(rel)) { setPreviewMode('md'); renderMd(); }
  else if (previewMode === 'md') setPreviewMode('pdf');
}

async function saveFile(force) {
  if (!curf.path) return;
  const text = docText();
  const q = '?path=' + encodeURIComponent(curf.path) + '&mtime=' + (force ? 'force' : curf.mtimeMs);
  const { status, body } = await api('/api/file' + q, { method: 'PUT', body: text });
  if (status === 409) {
    if (confirm('“' + curf.path + '” changed on disk. Overwrite it?')) return saveFile(true);
    return;
  }
  curf.mtimeMs = body.mtimeMs;
  curf.saved = text;
  setDirty(false);
  status200flash('saved');
}

// ------------------------------------------------------------------ build
async function build() {
  const main = $('#mainFile').value;
  if (!main) { setStatus('pick a main .tex', 'err'); return; }
  if (curf.path && isDirty()) await saveFile();
  const btn = $('#build');
  btn.disabled = true;
  setStatus('building…');
  try {
    const { body } = await api('/api/compile', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ main }),
    });
    renderLog(body.log);
    $('#logMeta').textContent = `exit ${body.code} · ${(body.durationMs / 1000).toFixed(1)}s`;
    if (body.ok && body.pdf) {
      setStatus('build ok', 'ok');
      const src = '/api/pdf?path=' + encodeURIComponent(body.pdf) + '&t=' + Date.now();
      $('#openPdf').href = src;
      setPreviewMode('pdf'); // note: keeps `empty-shown` until loadPdf sets pdfLoaded
      lastPdfPage = 0; lastPdfV = null;
      // the PDF render is independent of the (successful) build — never let it
      // stall the Build button or read as a build failure
      loadPdf(src)
        .then(() => { if (syncOn) syncFromEditor(); })
        .catch((e) => { status200flash('built — PDF preview: ' + e.message); });
    } else {
      setStatus('build failed', 'err');
      $('#logbar').classList.remove('collapsed');
      $('#logToggle').textContent = '▾ build log';
    }
  } catch (e) {
    setStatus(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}
function renderLog(text) {
  const el = $('#log');
  el.textContent = '';
  for (const line of (text || '').split('\n')) {
    const d = document.createElement('div');
    d.textContent = line;
    if (/^!|error|\bundefined\b|fatal/i.test(line)) d.className = 'l-err';
    else if (/warning/i.test(line)) d.className = 'l-warn';
    el.appendChild(d);
  }
  el.scrollTop = el.scrollHeight;
}

// ------------------------------------------------------------------ markdown preview
// The right pane is a PDF viewer for .tex work and a live Markdown viewer when a
// .md file is open (GFM tables, KaTeX math, mermaid diagrams). The renderer
// libraries are pulled from the CDN the first time they're needed.
const MD_RE = /\.(md|markdown|mdown|mkd|mkdn|mdwn)$/i;
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/';
const SENT = String.fromCharCode(0xe000); // private-use sentinel for placeholders
let previewMode = 'pdf';
let mdTimer = null;
const _assets = {};

function loadAssets(key, urls) {
  if (_assets[key]) return _assets[key];
  _assets[key] = Promise.all(urls.map((u) => new Promise((res, rej) => {
    const css = u.endsWith('.css');
    const el = document.createElement(css ? 'link' : 'script');
    if (css) { el.rel = 'stylesheet'; el.href = u; } else { el.src = u; el.async = false; }
    // a stylesheet that never fires onload must not stall the whole load
    const to = setTimeout(() => (css ? res() : rej(new Error('timed out loading ' + u))), 20000);
    el.onload = () => { clearTimeout(to); res(); };
    el.onerror = () => { clearTimeout(to); (css ? res() : rej(new Error('could not load ' + u))); };
    document.head.appendChild(el);
  })));
  _assets[key].catch(() => { delete _assets[key]; }); // let a failed load be retried
  return _assets[key];
}
async function ensureMdLibs() {
  await loadAssets('md-core', [
    CDN + 'marked/12.0.2/marked.min.js',
    CDN + 'dompurify/3.1.6/purify.min.js',
    CDN + 'KaTeX/0.16.11/katex.min.css',
    CDN + 'KaTeX/0.16.11/katex.min.js',
  ]);
  await loadAssets('md-katex-auto', [CDN + 'KaTeX/0.16.11/contrib/auto-render.min.js']);
}

function setPreviewMode(m) {
  previewMode = m;
  const md = m === 'md';
  $('#pdfDoc').hidden = md;
  $('#mdView').hidden = !md;
  $('#openPdf').style.display = md ? 'none' : '';
  $('#pdfInvertBtn').style.display = md ? 'none' : '';
  $('#previewTitle').textContent = md ? 'Markdown preview' : 'PDF preview';
  $('#pdfWrap').classList.toggle('empty-shown', !md && !pdfLoaded);
}

// Turn Markdown source into a DOM tree.
//  - fenced / inline code and math ($…$, $$…$$, \(…\), \[…\]) are pulled out
//    before marked parses (so it can't mangle the backslashes / underscores);
//    code is put back before parsing, math is spliced in as KaTeX afterwards,
//    skipping anything in <code>/<pre>.
//  - every top-level block gets data-src-line (0-based) for editor <-> preview
//    scroll sync. The line is found by locating the token's raw text in the
//    (line-count-preserving) source, which is robust to link-ref definitions
//    and other tokens marked drops from the stream.
function mdToDom(src) {
  const S = SENT;
  const code = [];
  let s = src.replace(
    /(^|\n)([ \t]{0,3})(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\2\3[ \t]*)(?=$|\n)/g,
    (m, lead) => lead + S + 'C' + (code.push(m.slice(lead.length)) - 1) + S);
  s = s.replace(/`[^`\n]+`/g, (m) => S + 'C' + (code.push(m) - 1) + S);

  const math = [];
  const put = (x, d) => S + 'K' + (math.push({ x, d }) - 1) + S + '\n'.repeat((x.match(/\n/g) || []).length);
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => put(x, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => put(x, true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => put(x, false));
  s = s.replace(/(^|[^\\$])\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/g,
    (_, pre, x) => pre + put(x, false));

  s = s.replace(new RegExp(S + 'C(\\d+)' + S, 'g'), (_, i) => code[+i]); // restore code for marked

  const M = window.marked;
  const toks = M.lexer(s);
  const parts = [];
  let from = 0;
  for (const tok of toks) {
    if (tok.type === 'space') { from += tok.raw.length; continue; }
    const at = s.indexOf(tok.raw, from);
    const before = at >= 0 ? s.slice(0, at) : s.slice(0, from);
    const startLine = (before.match(/\n/g) || []).length;
    if (at >= 0) from = at + tok.raw.length;
    let frag;
    try { frag = M.parser([tok]); } catch (e) { continue; }
    frag = frag.replace(/^(\s*)(<[a-zA-Z][\w:-]*)/, `$1$2 data-src-line="${startLine}"`);
    parts.push(frag);
  }
  let html = window.DOMPurify.sanitize(parts.join('\n'), { ADD_ATTR: ['align'] });

  const root = document.createElement('div');
  root.innerHTML = html;

  const reK = new RegExp(S + 'K(\\d+)' + S);
  const reKg = new RegExp(S + 'K(\\d+)' + S, 'g');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!reK.test(n.nodeValue) || (n.parentElement && n.parentElement.closest('code, pre'))) continue;
    hits.push(n);
  }
  for (const n of hits) {
    const frag = document.createDocumentFragment();
    let last = 0; let m; const str = n.nodeValue;
    reKg.lastIndex = 0;
    while ((m = reKg.exec(str))) {
      if (m.index > last) frag.appendChild(document.createTextNode(str.slice(last, m.index)));
      const { x, d } = math[+m[1]];
      const span = document.createElement('span');
      try { span.innerHTML = window.katex.renderToString(x, { displayMode: d, throwOnError: false }); }
      catch (e) { span.className = 'katex-error'; span.textContent = (d ? '$$' : '$') + x + (d ? '$$' : '$'); }
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
    n.replaceWith(frag);
  }

  let hasMermaid = false;
  root.querySelectorAll('code.language-mermaid, code.lang-mermaid').forEach((c) => {
    const host = c.closest('pre') || c;
    const d = document.createElement('div');
    d.className = 'mermaid';
    d.textContent = c.textContent;
    host.replaceWith(d);
    hasMermaid = true;
  });
  return { root, hasMermaid };
}

async function renderMermaid(host) {
  await loadAssets('mermaid', [CDN + 'mermaid/10.9.3/mermaid.min.js']);
  window.mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict',
    theme: app.dataset.theme === 'dark' ? 'dark' : 'default',
  });
  try { await window.mermaid.run({ nodes: host.querySelectorAll('.mermaid') }); }
  catch (e) { /* mermaid writes its own error into the node */ }
}

async function renderMd() {
  if (previewMode !== 'md') return;
  const view = $('#mdView');
  const src = docText();
  try { await ensureMdLibs(); }
  catch (e) { view.innerHTML = ''; view.append(Object.assign(document.createElement('div'), { className: 'md-err', textContent: 'preview libraries failed to load — ' + e.message })); return; }
  if (previewMode !== 'md' || docText() !== src) return; // changed while loading
  let out;
  try { out = mdToDom(src); }
  catch (e) { view.innerHTML = ''; view.append(Object.assign(document.createElement('div'), { className: 'md-err', textContent: 'render error — ' + e.message })); return; }
  const top = view.scrollTop;
  view.innerHTML = '';
  view.append(out.root);
  view.scrollTop = top;
  mdAnchors = [...view.querySelectorAll('[data-src-line]')]
    .map((el) => ({ line: +el.dataset.srcLine, el }))
    .sort((a, b) => a.line - b.line);
  if (out.hasMermaid) renderMermaid(view);
  if (syncOn) syncFromEditor();
}
function scheduleMd() { clearTimeout(mdTimer); mdTimer = setTimeout(renderMd, 220); }

// ------------------------------------------------------------------ pdf viewer
// The PDF preview is a pdf.js render view (not the browser's native plugin) so
// we can position it precisely, highlight a spot, and read clicks back for
// reverse SyncTeX. Libraries are pulled from cdnjs on first use; pinned to the
// last classic-UMD release (4.x is ESM-only).
const PDFJS = '3.11.174';
let pdfjsReady = null;
let pdfViewer = null;
let pdfLinkService = null;
let pdfEventBus = null;
let pdfDocObj = null;
let pdfLoaded = false;
let pdfUrl = null;
let _pdfKeep = null;
let pdfHlEl = null;
let pdfFitRO = null;
let reverseJumpGuard = 0;
let pdfSeq = 0; // bumped on every loadPdf/unloadPdf so a stale in-flight load bails
function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
// A cross-origin `new Worker(cdn)` is blocked, but a same-origin blob worker
// may `importScripts()` a cross-origin script — the standard pdf.js workaround.
// Falls back to the /api/pdfjs-worker proxy if Blob URLs are unavailable.
function pdfWorkerSrc() {
  const w = CDN + 'pdf.js/' + PDFJS + '/pdf.worker.min.js';
  try {
    return URL.createObjectURL(new Blob(['importScripts(' + JSON.stringify(w) + ');'],
      { type: 'text/javascript' }));
  } catch (e) {
    return '/api/pdfjs-worker';
  }
}
function ensurePdfLibs() {
  if (pdfjsReady) return pdfjsReady;
  // The stylesheet is cosmetic and must not gate readiness (a slow/blocked
  // <link> would otherwise delay or fail the whole thing) — fire it separately.
  loadAssets('pdfjs-css', [CDN + 'pdf.js/' + PDFJS + '/pdf_viewer.min.css']).catch(() => {});
  // pdf_viewer's webpack build grabs `globalThis.pdfjsLib` the moment it runs
  // and caches it — so pdf.min.js MUST be fully loaded first, otherwise the
  // viewer captures `undefined` (=> "f is undefined / AnnotationEditorType").
  pdfjsReady = loadAssets('pdfjs-core', [CDN + 'pdf.js/' + PDFJS + '/pdf.min.js'])
    .then(() => loadAssets('pdfjs-viewer', [CDN + 'pdf.js/' + PDFJS + '/pdf_viewer.min.js']))
    .then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
    });
  pdfjsReady.catch(() => { pdfjsReady = null; }); // allow retry on next build
  return pdfjsReady;
}
function waitForWidth(el, ms) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (el.clientWidth > 20 || performance.now() - t0 > (ms || 3000)) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}
// Apply 'page-width' once the container actually has a width. On the very first
// build the PDF pane may still be 0-wide when `pagesinit` fires, which left the
// pages unscaled/invisible until a second build — retry across a few frames.
function fitPdf(tries) {
  if (!pdfViewer || !pdfViewer.pdfDocument) return;
  const w = $('#pdfDoc').clientWidth;
  if (w > 20) { try { pdfViewer.currentScaleValue = 'page-width'; } catch (e) { /* ignore */ } return; }
  if ((tries || 0) < 30) requestAnimationFrame(() => fitPdf((tries || 0) + 1));
}
// PDF dark mode. `pdfInvert`: 'auto' follows the app theme, 'on'/'off' override.
// Toggle cycles auto -> on -> off with Alt+I (see the keydown listener).
let pdfInvert = 'auto';
function applyPdfInvert() {
  const on = pdfInvert === 'on' || (pdfInvert === 'auto' && app.dataset.theme === 'dark');
  $('#pdfDoc').classList.toggle('pdf-invert', on);
  const b = $('#pdfInvertBtn');
  if (b) {
    b.classList.toggle('active', on);
    b.title = 'PDF dark mode: ' + (pdfInvert === 'auto' ? 'auto (follows theme)' : pdfInvert) + ' — Alt+I';
  }
}
function cyclePdfInvert() {
  pdfInvert = pdfInvert === 'auto' ? 'on' : pdfInvert === 'on' ? 'off' : 'auto';
  LS.set('pdfInvert', pdfInvert);
  applyPdfInvert();
  status200flash('PDF ' + (pdfInvert === 'auto' ? 'dark: follows theme' : 'dark: ' + pdfInvert));
}

// Re-fit + repaint a few times after a fresh setDocument, in case the pane's
// size settles a frame or two late.
function kickPdfRender() {
  [0, 120, 400].forEach((ms) => setTimeout(() => {
    if (!pdfViewer || !pdfViewer.pdfDocument) return;
    fitPdf(0);
    try { pdfViewer.update(); } catch (e) { /* ignore */ }
  }, ms));
}
function initPdfViewer() {
  if (pdfViewer) return;
  pdfEventBus = new window.pdfjsViewer.EventBus();
  pdfLinkService = new window.pdfjsViewer.PDFLinkService({ eventBus: pdfEventBus });
  pdfViewer = new window.pdfjsViewer.PDFViewer({
    container: $('#pdfDoc'),
    viewer: $('#pdfViewer'),
    eventBus: pdfEventBus,
    linkService: pdfLinkService,
    textLayerMode: 1,
    // AnnotationEditorType.DISABLE — otherwise PDFViewer builds an
    // AnnotationEditorUIManager with no altTextManager, whose destroy() then
    // throws "can't access property destroy, this.#st is null" on teardown.
    annotationEditorMode: -1,
  });
  pdfLinkService.setViewer(pdfViewer);
  pdfEventBus.on('pagesinit', () => { fitPdf(0); restorePdfScroll(); });
  pdfEventBus.on('pagesloaded', () => { fitPdf(0); try { pdfViewer.update(); } catch (e) { /* ignore */ } });
  pdfFitRO = new ResizeObserver(debounce(() => fitPdf(0), 120));
  pdfFitRO.observe($('#pdfDoc'));
  $('#pdfDoc').addEventListener('click', onPdfClick);
  try { pdfViewer.setDocument(null); } catch (e) { /* prime */ }
}
async function loadPdf(url) {
  const seq = ++pdfSeq;
  await ensurePdfLibs();
  if (seq !== pdfSeq) return;
  initPdfViewer();
  const keepPage = pdfLoaded ? pdfViewer.currentPageNumber : 0;
  const old = pdfDocObj;
  pdfDocObj = null; pdfLoaded = false;
  if (old) {
    try { pdfViewer.setDocument(null); } catch (e) { /* ignore */ }
    try { await old.destroy(); } catch (e) { /* ignore */ }
    if (seq !== pdfSeq) return;
  }
  let doc;
  try {
    doc = await window.pdfjsLib.getDocument({ url }).promise;
  } catch (e) {
    if (seq === pdfSeq) throw e;
    return;
  }
  if (seq !== pdfSeq) { try { await doc.destroy(); } catch (e) { /* ignore */ } return; }
  await waitForWidth($('#pdfDoc'), 3000);
  if (seq !== pdfSeq) { try { await doc.destroy(); } catch (e) { /* ignore */ } return; }
  _pdfKeep = keepPage ? { page: keepPage } : null;
  pdfDocObj = doc;
  pdfViewer.setDocument(doc);
  pdfLinkService.setDocument(doc, null);
  pdfLoaded = true;
  pdfUrl = url;
  $('#pdfWrap').classList.remove('empty-shown'); // reveal now that a doc is in
  kickPdfRender();
}
function restorePdfScroll() {
  if (_pdfKeep && _pdfKeep.page && _pdfKeep.page <= pdfViewer.pagesCount) {
    pdfViewer.currentPageNumber = _pdfKeep.page;
  }
  _pdfKeep = null;
}
function unloadPdf() {
  pdfSeq++;
  if (pdfViewer) { try { pdfViewer.setDocument(null); } catch (e) { /* ignore */ } }
  const old = pdfDocObj;
  pdfDocObj = null;
  pdfLoaded = false;
  pdfUrl = null;
  if (old) { try { old.destroy(); } catch (e) { /* ignore */ } }
}
function pdfGoto(page, xPt, yPt) {
  if (!pdfViewer || !pdfLoaded || page > pdfViewer.pagesCount) return;
  try {
    pdfViewer.scrollPageIntoView({
      pageNumber: page,
      destArray: xPt == null ? null : [null, { name: 'XYZ' }, xPt, yPt, null],
    });
  } catch (e) { /* pages not laid out yet */ }
}

// Flash a fading box over a spot on a rendered page. `rect` is in unscaled PDF
// points, top-left origin: { xPt, yTopPt, wPt, hPt }.
function showSynctexHighlight(page, rect) {
  const pv = pdfViewer && pdfViewer.getPageView(page - 1);
  if (!pv || !pv.div || !pv.viewport) {
    if (pdfEventBus) {
      const again = (e) => {
        if (e.pageNumber !== page) return;
        pdfEventBus.off('pagerendered', again);
        showSynctexHighlight(page, rect);
      };
      pdfEventBus.on('pagerendered', again);
    }
    return;
  }
  const s = pv.viewport.scale;
  if (!pdfHlEl) { pdfHlEl = document.createElement('div'); pdfHlEl.className = 'synctex-hl'; }
  let left, top, width, height;
  if (rect.wPt > 1 && rect.hPt > 1) {
    left = rect.xPt * s;
    top = (rect.yTopPt - rect.hPt) * s;
    width = rect.wPt * s;
    height = (rect.hPt + 4) * s;
  } else {
    left = 0;
    width = pv.div.clientWidth;
    top = rect.yTopPt * s - 6;
    height = 12;
  }
  pdfHlEl.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
  pv.div.appendChild(pdfHlEl);
  pdfHlEl.classList.remove('synctex-hl');
  void pdfHlEl.offsetWidth; // restart the fade
  pdfHlEl.classList.add('synctex-hl');
  const done = () => { pdfHlEl.removeEventListener('animationend', done); if (pdfHlEl.parentNode) pdfHlEl.remove(); };
  pdfHlEl.addEventListener('animationend', done);
}

// Click on the rendered PDF -> open the matching source file at its line.
function onPdfClick(e) {
  if (!syncOn || !syncCap.synctex || !pdfViewer) return;
  const pageEl = e.target.closest && e.target.closest('.page');
  if (!pageEl) return;
  const pageNumber = +pageEl.dataset.pageNumber;
  const pv = pdfViewer.getPageView(pageNumber - 1);
  if (!pv || !pv.div || !pv.viewport) return;
  const r = pv.div.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const [xPdf, yPdf] = pv.viewport.convertToPdfPoint(cx, cy);
  const hPt = xPdf;
  const vPt = pv.viewport.viewBox[3] - yPdf; // -> top-left origin
  reverseSync($('#mainFile').value, pageNumber, hPt, vPt);
}
async function reverseSync(main, page, hPt, vPt) {
  if (!main) return;
  let r;
  try {
    r = (await api('/api/synctex-reverse?main=' + encodeURIComponent(main) +
      '&page=' + page + '&h=' + hPt.toFixed(2) + '&v=' + vPt.toFixed(2))).body;
  } catch { return; }
  if (!r || !r.ok || !r.file) { status200flash('no source for that spot'); return; }
  await jumpToSource(r.file, r.line);
}
async function jumpToSource(file, line) {
  const cur = curf.path ? curf.path.split('\\').join('/') : null;
  if (cur !== file) {
    await openFile(file);
    if (!curf.path || curf.path.split('\\').join('/') !== file) return; // user cancelled
  }
  const ln = Math.max(0, (line || 1) - 1);
  reverseJumpGuard = performance.now() + 400; // suppress the caret-driven forward sync we're about to cause
  lastPdfPage = 0; lastPdfV = null;
  setCaret(ln, 0);
  view.focus();
  flashLine(ln);
}
function flashLine(ln) {
  if (ln < 0 || ln >= view.state.doc.lines) return;
  ed.flash(ln);
}

// ------------------------------------------------------------------ view sync
// A toggle (⇅) links editor and preview scrolling.
//   Markdown: bidirectional, anchored on the data-src-line of each block.
//   PDF:      editor <-> PDF via SyncTeX (see the pdf viewer section).
let syncOn = false;
let syncCap = { synctex: false };
let mdAnchors = [];
let pdfSyncTimer = null;
let lastPdfPage = 0;
let lastPdfV = null;

// Eased scrolling: each pane has a tween that lerps toward a mutable target on
// its own rAF loop; a fresh .to() mid-flight just retargets. `prog[name]` is
// bumped on every programmatic write so the *other* pane's handler can tell a
// programmatic scroll from a user one (paneBusy) for as long as the tween runs
// plus one trailing frame — this replaces the old fixed-250ms lock.
const tw = {};
const prog = { editor: 0, preview: 0 };
function makePaneTween(name, read, write) {
  let raf = 0;
  let target = 0;
  let active = false;
  const step = () => {
    const cur = read();
    const d = target - cur;
    if (Math.abs(d) <= 0.5) { write(target); prog[name] = performance.now(); active = false; raf = 0; return; }
    write(cur + d * 0.2);
    prog[name] = performance.now();
    raf = requestAnimationFrame(step);
  };
  return {
    get active() { return active; },
    to(y) { target = y; if (!active) { active = true; raf = requestAnimationFrame(step); } },
    cancel() { if (raf) cancelAnimationFrame(raf); raf = 0; active = false; },
  };
}
function paneBusy(name) {
  return (tw[name] && tw[name].active) || (performance.now() - prog[name]) < 64;
}
function rafThrottle(fn) {
  let queued = false;
  return () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); };
}
function editorTopLine() {
  return posAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop + 2).from).line;
}
function syncFromEditor() {
  if (!syncOn || paneBusy('editor')) return;
  if (previewMode === 'md') mdSyncFromEditor();
  else pdfSyncFromEditor();
}
const maxScroll = (el) => Math.max(1, el.scrollHeight - el.clientHeight);
function mdSyncFromEditor() {
  if (previewMode !== 'md' || paneBusy('editor')) return;
  const view = $('#mdView');
  if (!mdAnchors.length) { // no anchors (render failed / empty) -> proportional
    const si = edScroll();
    tw.preview.to((si.top / Math.max(1, si.height - si.clientHeight)) * maxScroll(view));
    return;
  }
  const top = editorTopLine();
  let i = 0;
  while (i + 1 < mdAnchors.length && mdAnchors[i + 1].line <= top) i++;
  const a = mdAnchors[i];
  const b = mdAnchors[i + 1];
  const aTop = a.el.offsetTop;
  const bTop = b ? b.el.offsetTop : view.scrollHeight;
  const span = b ? b.line - a.line : Math.max(1, top - a.line + 1);
  const frac = Math.max(0, Math.min(1, (top - a.line) / span));
  tw.preview.to(aTop + (bTop - aTop) * frac - 6);
}
function mdSyncFromPreview() {
  if (!syncOn || paneBusy('preview') || previewMode !== 'md') return;
  const view = $('#mdView');
  if (!mdAnchors.length) {
    const si = edScroll();
    tw.editor.to((view.scrollTop / maxScroll(view)) * Math.max(1, si.height - si.clientHeight));
    return;
  }
  const y = view.scrollTop + 6;
  let i = 0;
  while (i + 1 < mdAnchors.length && mdAnchors[i + 1].el.offsetTop <= y) i++;
  const a = mdAnchors[i];
  const b = mdAnchors[i + 1];
  const aTop = a.el.offsetTop;
  const bTop = b ? b.el.offsetTop : view.scrollHeight;
  const span = b ? b.line - a.line : 1;
  const frac = bTop > aTop ? Math.max(0, Math.min(1, (y - aTop) / (bTop - aTop))) : 0;
  tw.editor.to(edHeightAtLine(Math.floor(a.line + span * frac)) - 4);
}
const SP = 65536;
function pdfSyncFromEditor(opts) {
  const fromCaret = !!(opts && opts.fromCaret);
  if (previewMode !== 'pdf' || !syncCap.synctex || !pdfLoaded) return;
  if (!curf.path || !/\.tex$/i.test(curf.path)) return;
  const main = $('#mainFile').value;
  if (!main) return;
  const line = (fromCaret ? posAt(view.state.selection.main.head).line : editorTopLine()) + 1;
  clearTimeout(pdfSyncTimer);
  pdfSyncTimer = setTimeout(async () => {
    let r;
    try {
      r = (await api('/api/synctex?main=' + encodeURIComponent(main) +
        '&file=' + encodeURIComponent(curf.path) + '&line=' + line)).body;
    } catch { return; }
    if (!r || !r.ok || !r.page) return;
    // relaxed dedup: repeat only when we're on the same page AND within ~a line
    if (r.page === lastPdfPage && lastPdfV != null && Math.abs(r.v - lastPdfV) < 4000) return;
    lastPdfPage = r.page; lastPdfV = r.v;
    const MAG = (r.mag || 1000) / 1000;
    const xPt = (r.h * (r.unit || 1) + (r.xoff || 0)) / SP * MAG;
    const vTopPt = (r.v * (r.unit || 1) + (r.yoff || 0)) / SP * MAG;
    const pv = pdfViewer.getPageView(r.page - 1);
    const pageHpt = pv && pv.viewport ? pv.viewport.viewBox[3] : 842;
    pdfGoto(r.page, xPt, (pageHpt - vTopPt) + 12);
    showSynctexHighlight(r.page, {
      xPt,
      yTopPt: vTopPt,
      wPt: (r.W || 0) / SP * MAG,
      hPt: ((r.H || 0) + (r.D || 0)) / SP * MAG,
    });
  }, fromCaret ? 180 : 300);
}
function onCaretActivity() {
  if (!syncOn || previewMode !== 'pdf' || paneBusy('editor')) return;
  if (performance.now() < reverseJumpGuard) return; // don't bounce a PDF-click jump back
  pdfSyncFromEditor({ fromCaret: true });
}

// ------------------------------------------------------------------ status
let statusTimer = null;
function setStatus(msg, cls) {
  const s = $('#status');
  s.textContent = msg || '';
  s.className = 'status' + (cls ? ' ' + cls : '');
}
function status200flash(msg) {
  setStatus(msg, 'ok');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => setStatus(''), 1500);
}

// ------------------------------------------------------------------ file tree
const AUX_RE = /\.(aux|bbl|bcf|blg|fdb_latexmk|fls|log|out|run\.xml|toc|lof|lot|xdv|synctex\.gz|nav|snm|vrb)$/i;
let treeData = null;
const expanded = new Set(LS.get('expanded', []));

function extClass(name) {
  const e = (name.split('.').pop() || '').toLowerCase();
  return ['tex', 'bib', 'md', 'sty', 'cls'].includes(e) ? ' ext-' + e : '';
}
function renderTree() {
  const showAux = $('#showAux').checked;
  const mainPath = LS.get('main', '');
  const root = document.createElement('ul');
  const walk = (nodes, parentUl) => {
    for (const n of nodes) {
      if (n.type === 'file' && !showAux && AUX_RE.test(n.name)) continue;
      const li = document.createElement('li');
      li.className = n.type === 'dir' ? 'dir' : 'file';
      if (n.type === 'dir' && expanded.has(n.path)) li.classList.add('open');
      const row = document.createElement('div');
      row.className = 'row' + (n.type === 'file' ? extClass(n.name) : '');
      row.dataset.path = n.path;
      row.dataset.type = n.type;
      const tw = document.createElement('span');
      tw.className = 'twist';
      tw.textContent = n.type === 'dir' ? (expanded.has(n.path) ? '▾' : '▸') : '';
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = n.name;
      row.append(tw, nm);
      if (n.type === 'file' && /\.tex$/i.test(n.name)) {
        const isMain = n.path === mainPath;
        const b = document.createElement('span');
        b.className = 'main-badge' + (isMain ? ' is-main' : '');
        b.textContent = isMain ? 'main' : 'set main';
        b.title = isMain ? 'this is the master file' : 'set as master file';
        b.dataset.setmain = n.path;
        row.append(b);
      }
      li.append(row);
      if (n.type === 'dir') {
        const ul = document.createElement('ul');
        walk(n.children || [], ul);
        li.append(ul);
      }
      parentUl.append(li);
    }
  };
  walk(treeData, root);
  const host = $('#tree');
  host.innerHTML = '';
  host.append(root);
  if (curf.path) markActiveInTree(curf.path);
}
function markActiveInTree(p) {
  document.querySelectorAll('.tree .row.active').forEach((r) => r.classList.remove('active'));
  const r = document.querySelector('.tree .row[data-path="' + CSS.escape(p) + '"]');
  if (r) r.classList.add('active');
}
$('#tree').addEventListener('click', (e) => {
  const setmain = e.target.closest('[data-setmain]');
  if (setmain) { e.stopPropagation(); setMain(setmain.dataset.setmain); return; }
  const row = e.target.closest('.row');
  if (!row) return;
  if (row.dataset.type === 'dir') {
    const p = row.dataset.path;
    if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
    LS.set('expanded', [...expanded]);
    renderTree();
  } else {
    openFile(row.dataset.path);
  }
});
async function loadTree() {
  const { body } = await api('/api/tree');
  treeData = body.tree;
  $('#rootName').textContent = body.rootName;
  $('#rootName').title = body.root;
  populateMainSelect();
  renderTree();
}

// ------------------------------------------------------------------ tree context menu
const ctxMenu = $('#ctxMenu');
const dirName = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const baseName = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); };
const joinRel = (dir, name) => (dir ? dir + '/' + name : name);
const jsonHeaders = { headers: { 'content-type': 'application/json' } };

function closeCtxMenu() { ctxMenu.hidden = true; ctxMenu.innerHTML = ''; }
function ctxItem(label, fn, danger) {
  const b = document.createElement('button');
  b.textContent = label;
  if (danger) b.className = 'danger';
  b.addEventListener('click', () => { closeCtxMenu(); fn(); });
  return b;
}
function openCtxMenu(x, y, entry) {
  ctxMenu.innerHTML = '';
  const isDirTarget = !entry || entry.type === 'dir';
  if (isDirTarget) {
    const dir = entry ? entry.path : '';
    ctxMenu.append(ctxItem('New file', () => createEntry(dir, 'file')));
    ctxMenu.append(ctxItem('New folder', () => createEntry(dir, 'dir')));
  }
  if (entry) {
    if (isDirTarget) ctxMenu.append(document.createElement('hr'));
    ctxMenu.append(ctxItem('Rename', () => renameEntry(entry)));
    ctxMenu.append(ctxItem('Duplicate', () => duplicateEntry(entry)));
    ctxMenu.append(ctxItem('Delete', () => deleteEntry(entry), true));
  }
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  if (r.right > window.innerWidth) ctxMenu.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
  if (r.bottom > window.innerHeight) ctxMenu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
}
$('#tree').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.row');
  openCtxMenu(e.clientX, e.clientY, row ? { path: row.dataset.path, type: row.dataset.type } : null);
});
window.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) closeCtxMenu(); });
window.addEventListener('blur', closeCtxMenu);
window.addEventListener('scroll', closeCtxMenu, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });

async function createEntry(dir, type) {
  const label = type === 'dir' ? 'folder' : 'file';
  const name = prompt('New ' + label + (dir ? ' in "' + dir + '/"' : '') + ':');
  if (!name || !name.trim()) return;
  const p = joinRel(dir, name.trim());
  try {
    await api('/api/entry', Object.assign({ method: 'POST', body: JSON.stringify({ path: p, type }) }, jsonHeaders));
  } catch (e) { alert(e.message); return; }
  if (dir) { expanded.add(dir); LS.set('expanded', [...expanded]); }
  await loadTree();
  if (type === 'file') openFile(p).catch((e) => alert(e.message));
}
async function renameEntry(entry) {
  const dir = dirName(entry.path);
  const oldName = baseName(entry.path);
  const name = prompt('Rename "' + oldName + '" to:', oldName);
  if (!name || !name.trim() || name.trim() === oldName) return;
  const to = joinRel(dir, name.trim());
  try {
    await api('/api/entry?path=' + encodeURIComponent(entry.path), Object.assign({ method: 'PUT', body: JSON.stringify({ to }) }, jsonHeaders));
  } catch (e) { alert(e.message); return; }
  if (curf.path === entry.path) {
    curf.path = to;
    LS.set('lastFile', to);
    $('#fileName').textContent = to;
  } else if (entry.type === 'dir' && curf.path && curf.path.startsWith(entry.path + '/')) {
    curf.path = to + curf.path.slice(entry.path.length);
    LS.set('lastFile', curf.path);
    $('#fileName').textContent = curf.path;
  }
  if (expanded.has(entry.path)) { expanded.delete(entry.path); expanded.add(to); }
  if (dir) expanded.add(dir);
  LS.set('expanded', [...expanded]);
  await loadTree();
  if (curf.path) markActiveInTree(curf.path);
}
async function duplicateEntry(entry) {
  const dir = dirName(entry.path);
  const base = baseName(entry.path);
  const dot = entry.type === 'file' ? base.lastIndexOf('.') : -1;
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const name = prompt('Duplicate "' + entry.path + '" as:', stem + ' copy' + ext);
  if (!name || !name.trim()) return;
  try {
    await api('/api/copy', Object.assign({ method: 'POST', body: JSON.stringify({ from: entry.path, to: joinRel(dir, name.trim()) }) }, jsonHeaders));
  } catch (e) { alert(e.message); return; }
  if (dir) { expanded.add(dir); LS.set('expanded', [...expanded]); }
  await loadTree();
}
async function deleteEntry(entry) {
  const what = entry.type === 'dir' ? 'folder and everything inside it' : 'file';
  if (!confirm('Delete this ' + what + '?\n\n' + entry.path)) return;
  try {
    await api('/api/entry?path=' + encodeURIComponent(entry.path), { method: 'DELETE' });
  } catch (e) { alert(e.message); return; }
  if (curf.path === entry.path || (entry.type === 'dir' && curf.path && curf.path.startsWith(entry.path + '/'))) {
    curf = { path: null, mtimeMs: 0, saved: '' };
    ed.setDoc('% open a file from the tree\n');
    applyDir();
    $('#fileName').textContent = 'no file open';
    setDirty(false);
  }
  expanded.delete(entry.path);
  await loadTree();
}

// ------------------------------------------------------------------ main file
function flattenTex(nodes, acc) {
  for (const n of nodes) {
    if (n.type === 'dir') flattenTex(n.children || [], acc);
    else if (/\.tex$/i.test(n.name)) acc.push(n.path);
  }
  return acc;
}
function populateMainSelect() {
  const sel = $('#mainFile');
  const texs = flattenTex(treeData, []);
  const saved = LS.get('main', '');
  sel.innerHTML = '<option value="">—</option>' + texs.map((p) => `<option value="${p}">${p}</option>`).join('');
  const rootTexs = texs.filter((p) => !p.includes('/'));
  const pick = saved && texs.includes(saved) ? saved
    : texs.find((p) => /(^|\/)(main|thesis)\.tex$/i.test(p))
    || rootTexs[0] || texs[0] || '';
  sel.value = pick;
  LS.set('main', pick);
}
function setMain(p) {
  $('#mainFile').value = p;
  LS.set('main', p);
  status200flash('main → ' + p);
  renderTree();
}
$('#mainFile').addEventListener('change', (e) => { LS.set('main', e.target.value); renderTree(); });

// Ask which .tex is the compile root right after a folder is opened, instead
// of guessing by filename — a master named e.g. "PhDThesis.tex" doesn't match
// a main|thesis.tex pattern, and a name-blind sub-file (no \documentclass) can
// still sort first and get latexmk pointed at something that fails to build
// on its own. The default highlighted here is content-based instead: whichever
// candidate actually contains \documentclass.
const mainDlg = $('#mainDlg');
async function detectMaster(texs) {
  const hits = await Promise.all(texs.map(async (p) => {
    try {
      const { body } = await api('/api/file?path=' + encodeURIComponent(p));
      return /\\documentclass\b/.test(body.content) ? p : null;
    } catch { return null; }
  }));
  return hits.find(Boolean) || null;
}
async function promptMainFile() {
  const texs = flattenTex(treeData, []);
  if (texs.length <= 1) return; // nothing to choose between
  const detected = await detectMaster(texs);
  const guess = detected || $('#mainFile').value;
  const ul = $('#mainDlgList');
  ul.innerHTML = '';
  for (const p of texs) {
    const li = document.createElement('li');
    li.className = 'dlg-item' + (p === guess ? ' guess' : '');
    li.textContent = '📄 ' + p;
    li.title = p;
    li.addEventListener('click', () => { setMain(p); mainDlg.close(); });
    ul.append(li);
  }
  if (detected) setMain(detected);
  if (typeof mainDlg.showModal === 'function') mainDlg.showModal();
  else mainDlg.setAttribute('open', '');
}
$('#mainDlgX').addEventListener('click', () => mainDlg.close());
$('#mainDlgCancel').addEventListener('click', () => mainDlg.close());

function findFirst(nodes, re) {
  for (const n of nodes) {
    if (n.type === 'file' && re.test(n.name)) return n.path;
    if (n.type === 'dir') { const r = findFirst(n.children || [], re); if (r) return r; }
  }
  return null;
}
async function refreshBibKeys(content) {
  try {
    let text = content;
    if (text == null) {
      const bib = findFirst(treeData, /\.bib$/i);
      if (!bib) return;
      text = (await api('/api/file?path=' + encodeURIComponent(bib))).body.content;
    }
    const keys = [];
    const re = /@\s*[a-zA-Z]+\s*\{\s*([^,\s}]+)\s*,/g;
    let m;
    while ((m = re.exec(text))) keys.push(m[1]);
    BIB_KEYS = [...new Set(keys)];
    if (BIB_KEYS.length) status200flash(BIB_KEYS.length + ' bib keys');
  } catch {}
}

// ------------------------------------------------------------------ splitters
function drag(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev);
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      refreshCM();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
drag($('#dragSidebar'), (e) => {
  const wb = $('#workbench').getBoundingClientRect();
  const w = Math.min(520, Math.max(140, e.clientX - wb.left));
  $('#workbench').style.setProperty('--sidebar-w', w + 'px');
  LS.set('sidebarW', w);
});
drag($('#dragPanes'), (e) => {
  const r = $('#panes').getBoundingClientRect();
  let ratio = (e.clientX - r.left) / r.width;
  if (app.dataset.editorSide === 'right') ratio = 1 - ratio;
  ratio = Math.min(0.85, Math.max(0.15, ratio));
  $('#panes').style.setProperty('--ed-flex', ratio.toFixed(3));
  $('#panes').style.setProperty('--pdf-flex', (1 - ratio).toFixed(3));
  LS.set('edFlex', ratio);
});

// ------------------------------------------------------------------ toolbar
$('#build').addEventListener('click', build);
$('#saveBtn').addEventListener('click', () => saveFile());
$('#refreshTree').addEventListener('click', loadTree);
$('#showAux').addEventListener('change', (e) => { LS.set('showAux', e.target.checked); renderTree(); });

$('#theme').addEventListener('click', () => {
  const next = app.dataset.theme === 'dark' ? 'light' : 'dark';
  app.dataset.theme = next;
  LS.set('theme', next);
  $('#theme').textContent = next === 'dark' ? '☾ dark' : '☀ light';
  // the editor recolours itself: its theme + highlight style are CSS-var driven
  applyPdfInvert(); // 'auto' PDF dark mode tracks the app theme
  if (previewMode === 'md') renderMd(); // re-theme mermaid diagrams
});
// PDF dark mode — the ◐ button on the preview pane, or Alt+I anywhere.
$('#pdfInvertBtn').addEventListener('click', cyclePdfInvert);
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    cyclePdfInvert();
  }
});
$('#swap').addEventListener('click', () => {
  app.dataset.editorSide = app.dataset.editorSide === 'left' ? 'right' : 'left';
  LS.set('side', app.dataset.editorSide);
  refreshCM();
});
$('#dirBtn').addEventListener('click', () => {
  const order = ['auto', 'rtl', 'ltr'];
  const next = order[(order.indexOf(LS.get('dir', 'auto')) + 1) % 3];
  LS.set('dir', next);
  $('#dirBtn').textContent = 'dir: ' + next;
  applyDir();
});
$('#sync').addEventListener('click', () => {
  syncOn = !syncOn;
  LS.set('sync', syncOn);
  $('#sync').classList.toggle('on', syncOn);
  if (syncOn) {
    lastPdfPage = 0; lastPdfV = null;
    tw.preview.cancel(); tw.editor.cancel();
    syncFromEditor();
  }
});
$('#logToggle').addEventListener('click', () => {
  const c = $('#logbar').classList.toggle('collapsed');
  $('#logToggle').textContent = (c ? '▸' : '▾') + ' build log';
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); saveFile(); }
  else if (k === 'b') { e.preventDefault(); build(); }
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ open folder
const dlg = $('#folderDlg');
let dlgCwd = null;
const recentRoots = () => LS.get('recentRoots', []);
function pushRecent(p) { LS.set('recentRoots', [p, ...recentRoots().filter((x) => x !== p)].slice(0, 6)); }
function renderRecent() {
  const host = $('#dlgRecent');
  const r = recentRoots();
  host.textContent = r.length ? 'recent: ' : '';
  for (const p of r) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p.split(/[\\/]/).filter(Boolean).pop() || p;
    b.title = p;
    b.addEventListener('click', () => browse(p).catch((e) => alert(e.message)));
    host.append(b);
  }
}
function dirLi(name, full, icon) {
  const li = document.createElement('li');
  li.className = 'dlg-item';
  li.textContent = icon + ' ' + name;
  li.title = full;
  li.addEventListener('click', () => browse(full).catch((e) => alert(e.message)));
  li.addEventListener('dblclick', () => chooseRoot(full));
  return li;
}
async function browse(p) {
  const { body } = await api('/api/browse' + (p ? '?path=' + encodeURIComponent(p) : ''));
  dlgCwd = body.path;
  $('#dlgPath').value = body.path;
  $('#dlgUp').disabled = !body.parent;
  $('#dlgUp').dataset.parent = body.parent || '';
  const ul = $('#dlgList');
  ul.innerHTML = '';
  for (const d of body.drives || []) ul.append(dirLi(d, d, '💽'));
  for (const d of body.dirs) ul.append(dirLi(d.name, d.path, '📁'));
  if (!body.dirs.length && !(body.drives || []).length) {
    const li = document.createElement('li');
    li.className = 'dlg-empty';
    li.textContent = body.error === 'unreadable' ? '(folder not readable)' : '(no sub-folders)';
    ul.append(li);
  }
}
async function chooseRoot(p) {
  if (!p) return;
  if (isDirty() && !confirm('Discard unsaved changes in ' + curf.path + '?')) return;
  try {
    const { body } = await api('/api/root', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    dlg.close();
    pushRecent(body.root);
    expanded.clear();
    LS.set('expanded', []);
    LS.set('lastFile', '');
    curf = { path: null, mtimeMs: 0, saved: '' };
    BIB_KEYS = [];
    ed.setDoc('% open a file from the tree\n');
    $('#fileName').textContent = 'no file open';
    setDirty(false);
    unloadPdf();
    $('#pdfWrap').classList.add('empty-shown');
    await loadTree();
    const bib = findFirst(treeData, /references\.bib$/i) || findFirst(treeData, /\.bib$/i);
    if (bib) { try { refreshBibKeys((await api('/api/file?path=' + encodeURIComponent(bib))).body.content); } catch {} }
    status200flash('root → ' + body.rootName);
    await promptMainFile();
  } catch (e) {
    alert('open folder: ' + e.message);
  }
}
async function openFolderDialog() {
  renderRecent();
  try { await browse(null); } catch { $('#dlgList').innerHTML = ''; $('#dlgPath').value = ''; }
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}
$('#openFolder').addEventListener('click', openFolderDialog);
$('#rootName').addEventListener('click', openFolderDialog);
$('#dlgX').addEventListener('click', () => dlg.close());
$('#dlgCancel').addEventListener('click', () => dlg.close());
$('#dlgUp').addEventListener('click', () => browse($('#dlgUp').dataset.parent || null).catch((e) => alert(e.message)));
$('#dlgGo').addEventListener('click', () => browse($('#dlgPath').value.trim()).catch((e) => alert(e.message)));
$('#dlgOpen').addEventListener('click', () => chooseRoot($('#dlgPath').value.trim() || dlgCwd));
$('#dlgPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dlgGo').click(); } });

// ------------------------------------------------------------------ boot
function restoreLayout() {
  app.dataset.theme = LS.get('theme', 'dark');
  app.dataset.editorSide = LS.get('side', 'left');
  $('#theme').textContent = app.dataset.theme === 'dark' ? '☾ dark' : '☀ light';
  // one-time reset: per-line "auto" alignment is the intended default now
  if (!LS.get('dirReset2', false)) { LS.set('dir', 'auto'); LS.set('dirReset2', true); }
  let dm = LS.get('dir', 'auto');
  if (!['rtl', 'auto', 'ltr'].includes(dm)) { dm = 'auto'; LS.set('dir', dm); }
  $('#dirBtn').textContent = 'dir: ' + dm;
  syncOn = LS.get('sync', false);
  $('#sync').classList.toggle('on', syncOn);
  pdfInvert = ['auto', 'on', 'off'].includes(LS.get('pdfInvert', 'auto')) ? LS.get('pdfInvert', 'auto') : 'auto';
  applyPdfInvert();
  $('#showAux').checked = LS.get('showAux', false);
  $('#workbench').style.setProperty('--sidebar-w', LS.get('sidebarW', 260) + 'px');
  const ef = LS.get('edFlex', 0.5);
  $('#panes').style.setProperty('--ed-flex', ef);
  $('#panes').style.setProperty('--pdf-flex', 1 - ef);
}

async function boot() {
  restoreLayout();
  if (typeof RTLCM === 'undefined' || !RTLCM.create) {
    $('#editor').innerHTML = '<p style="padding:16px;color:#c66">Editor bundle failed to load — run <code>npm i &amp;&amp; npm run build:editor</code>.</p>';
    setStatus('editor did not load', 'err');
    return;
  }
  initEditor();
  try {
    const { body } = await api('/api/health');
    if (body.lockRoot) $('#openFolder').style.display = 'none';
    syncCap.synctex = !!body.synctex;
    $('#sync').title = 'scroll editor ↔ preview together '
      + '(Markdown: two-way; PDF: editor → page via SyncTeX)';
    setStatus(body.latexmk ? (body.version || 'latexmk ready') : 'latexmk not found on PATH', body.latexmk ? 'ok' : 'err');
  } catch (e) { setStatus('server: ' + e.message, 'err'); }
  await loadTree();
  const last = LS.get('lastFile', '');
  if (last) { try { await openFile(last); } catch {} }
  const bib = findFirst(treeData, /references\.bib$/i) || findFirst(treeData, /\.bib$/i);
  if (bib) { try { refreshBibKeys((await api('/api/file?path=' + encodeURIComponent(bib))).body.content); } catch {} }
  refreshCM();
}
boot();
})();
