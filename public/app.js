/* RTL-Web-Editor — browser front-end (CodeMirror 5, plain script).
 * Editor with RTL/LTR direction, stex syntax highlighting, live PDF preview,
 * folder tree + folder switcher. Talks to server.js over /api/*.
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
let BIB_KEYS = [];

function collectMacros(text) {
  const out = new Set();
  const re = /\\(?:re)?newcommand\*?\s*\{?\s*\\([a-zA-Z@]+)|\\DeclareMathOperator\*?\s*\{\s*\\([a-zA-Z@]+)/g;
  let m;
  while ((m = re.exec(text))) out.add('\\' + (m[1] || m[2]));
  return [...out];
}

// ------------------------------------------------------------------ editor
let cm;

// --- per-line bidi -------------------------------------------------------------
// CodeMirror 5 has one editor-wide `direction`; it has no per-line base
// direction for caret motion. To edit mixed Persian/LaTeX correctly we:
//   1. keep the editor `direction` = "ltr" (so pure-LaTeX lines stay no-bidi);
//   2. compute each line's bidi order with ITS OWN base direction and pin it on
//      the line handle (`line.order`), so rendering + caret geometry match the
//      per-line CSS `direction` (see markCmdLine / styles.css `.rtl-line`);
//   3. flip `cm.doc.direction` for the duration of a cursor-motion command to
//      the line the caret sits on, so CodeMirror's motion math (which reads
//      `cm.doc.direction`) agrees with how that line is drawn (dirAwareMotion).
// `bidiOrder` below is CodeMirror 5's own bidiOrdering, inlined so we can call
// it with an explicit base direction. Returns `false` for a fully-LTR line, else
// an array of {level, from, to} spans in visual order. (CodeMirror MIT licence.)
const lst = (a) => a[a.length - 1];
const bidiOrder = (function () {
  const lowTypes = 'bbbbbbbbbtstwsbbbbbbbbbbbbbbssstwNN%%%NNNNNN,N,N1111111111NNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNbbbbbbsbbbbbbbbbbbbbbbbbbbbbbbbbb,N%%%%NNNNLNNNNN%%11NLNNN1LNNNNNLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLN';
  const arabicTypes = 'nnnnnnNNr%%r,rNNmmmmmmmmmmmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmmmmmmmmnnnnnnnnnn%nnrrrmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmnNmmmmmmrrmmNmmmmrr1111111111';
  function charType(code) {
    if (code <= 0xf7) return lowTypes.charAt(code);
    if (code >= 0x590 && code <= 0x5f4) return 'R';
    if (code >= 0x600 && code <= 0x6f9) return arabicTypes.charAt(code - 0x600);
    if (code >= 0x6ee && code <= 0x8ac) return 'r';
    if (code >= 0x2000 && code <= 0x200b) return 'w';
    if (code === 0x200c) return 'b';
    return 'L';
  }
  const bidiRE = /[֐-״؀-ۿ܀-ࢬ]/;
  const isNeutral = /[stwN]/;
  const isStrong = /[LRr]/;
  const countsAsLeft = /[Lb1n]/;
  const countsAsNum = /[1n]/;
  return function (str, direction) {
    const outerType = direction === 'ltr' ? 'L' : 'R';
    if (str.length === 0 || (direction === 'ltr' && !bidiRE.test(str))) return false;
    const len = str.length;
    const types = [];
    for (let i = 0; i < len; ++i) types.push(charType(str.charCodeAt(i)));
    for (let i = 0, prev = outerType; i < len; ++i) {
      const t = types[i];
      if (t === 'm') types[i] = prev; else prev = t;
    }
    for (let i = 0, cur = outerType; i < len; ++i) {
      const t = types[i];
      if (t === '1' && cur === 'r') types[i] = 'n';
      else if (isStrong.test(t)) { cur = t; if (t === 'r') types[i] = 'R'; }
    }
    for (let i = 1, prev = types[0]; i < len - 1; ++i) {
      const t = types[i];
      if (t === '+' && prev === '1' && types[i + 1] === '1') types[i] = '1';
      else if (t === ',' && prev === types[i + 1] && (prev === '1' || prev === 'n')) types[i] = prev;
      prev = t;
    }
    for (let i = 0; i < len; ++i) {
      const t = types[i];
      if (t === ',') types[i] = 'N';
      else if (t === '%') {
        let end;
        for (end = i + 1; end < len && types[end] === '%'; ++end) { /* scan */ }
        const replace = (i && types[i - 1] === '!') || (end < len && types[end] === '1') ? '1' : 'N';
        for (let j = i; j < end; ++j) types[j] = replace;
        i = end - 1;
      }
    }
    for (let i = 0, cur = outerType; i < len; ++i) {
      const t = types[i];
      if (cur === 'L' && t === '1') types[i] = 'L';
      else if (isStrong.test(t)) cur = t;
    }
    for (let i = 0; i < len; ++i) {
      if (isNeutral.test(types[i])) {
        let end;
        for (end = i + 1; end < len && isNeutral.test(types[end]); ++end) { /* scan */ }
        const before = (i ? types[i - 1] : outerType) === 'L';
        const after = (end < len ? types[end] : outerType) === 'L';
        const replace = before === after ? (before ? 'L' : 'R') : outerType;
        for (let j = i; j < end; ++j) types[j] = replace;
        i = end - 1;
      }
    }
    const order = [];
    let m;
    for (let i = 0; i < len;) {
      if (countsAsLeft.test(types[i])) {
        const start = i;
        for (++i; i < len && countsAsLeft.test(types[i]); ++i) { /* scan */ }
        order.push({ level: 0, from: start, to: i });
      } else {
        let pos = i;
        let at = order.length;
        const isRTL = direction === 'rtl' ? 1 : 0;
        for (++i; i < len && types[i] !== 'L'; ++i) { /* scan */ }
        for (let j = pos; j < i;) {
          if (countsAsNum.test(types[j])) {
            if (pos < j) { order.splice(at, 0, { level: 1, from: pos, to: j }); at += isRTL; }
            const nstart = j;
            for (++j; j < i && countsAsNum.test(types[j]); ++j) { /* scan */ }
            order.splice(at, 0, { level: 2, from: nstart, to: j });
            at += isRTL;
            pos = j;
          } else ++j;
        }
        if (pos < i) order.splice(at, 0, { level: 1, from: pos, to: i });
      }
    }
    if (direction === 'ltr') {
      if (order[0].level === 1 && (m = str.match(/^\s+/))) {
        order[0].from = m[0].length;
        order.unshift({ level: 0, from: 0, to: m[0].length });
      }
      if (lst(order).level === 1 && (m = str.match(/\s+$/))) {
        lst(order).to -= m[0].length;
        order.push({ level: 0, from: len - m[0].length, to: len });
      }
    }
    return direction === 'rtl' ? order.reverse() : order;
  };
})();

function applyDir() {
  if (!cm) return;
  const mode = LS.get('dir', 'auto');
  cm.setOption('direction', 'ltr');
  const w = cm.getWrapperElement().classList;
  w.toggle('force-rtl', mode === 'rtl');
  w.toggle('force-ltr', mode === 'ltr');
  w.remove('CodeMirror-rtl');
  cm.refresh();
}
const cmTheme = (name) => (name === 'dark' ? 'material-darker' : 'default');

function latexHint(editor) {
  const pos = editor.getCursor();
  const before = editor.getLine(pos.line).slice(0, pos.ch);
  const P = CodeMirror.Pos;
  let m;
  if ((m = /\\(?:cite|citep|citet|parencite|textcite|nocite|autocite)\{([^}]*)$/.exec(before))) {
    const w = m[1].toLowerCase();
    const list = BIB_KEYS.filter((k) => k.toLowerCase().includes(w));
    return { list: list.length ? list : BIB_KEYS, from: P(pos.line, pos.ch - m[1].length), to: pos };
  }
  if ((m = /\\(?:begin|end)\{([a-zA-Z*]*)$/.exec(before))) {
    const w = m[1];
    return { list: LATEX_ENVS.filter((e) => e.startsWith(w)), from: P(pos.line, pos.ch - w.length), to: pos };
  }
  if ((m = /\\([a-zA-Z]*)$/.exec(before))) {
    const w = m[1];
    const all = [...new Set(LATEX_CMDS.concat(collectMacros(editor.getValue())))];
    const list = all.filter((c) => c.slice(1).startsWith(w));
    return { list: list.length ? list : all, from: P(pos.line, pos.ch - w.length - 1), to: pos };
  }
  return null;
}

// Pin a line's bidi order to one computed with its own base direction, so its
// geometry matches the per-line CSS `direction`. CodeMirror nulls `line.order`
// on every text change; we recompute here (and whenever the base flips).
function pinOrder(lh, text) {
  if (!lh) return;
  const base = lineIsRtl(text || '') ? 'rtl' : 'ltr';
  if (lh._ob === base && lh.order !== null && lh.order !== undefined) return;
  lh.order = bidiOrder(text || '', base);
  lh._ob = base;
}

// Run a stock cursor-motion command with `cm.doc.direction` temporarily set to
// the base direction of the line the caret is on, so CodeMirror's motion math
// lines up with how that line is drawn (fixes arrows on a Latin run inside an
// RTL line, and End/Home on RTL lines). Registered under `go…` names so
// CodeMirror's Shift-key fallback still extends the selection through them.
function dirAwareMotion(ed, name) {
  const ln = ed.getCursor('head').line;
  const base = lineIsRtl(ed.getLine(ln) || '') ? 'rtl' : 'ltr';

  // Plain Left/Right (no Shift) on a non-empty selection collapses the caret to
  // the *visual* end the arrow points at — on an RTL line the from()/to() ends
  // are swapped, so CodeMirror's built-in "collapse to from()/to()" feels wrong.
  if ((name === 'goCharLeft' || name === 'goCharRight')
      && !ed.display.shift && !ed.doc.extend && ed.somethingSelected()) {
    const goLeft = name === 'goCharLeft';
    ed.setSelections(ed.listSelections().map((r) => {
      if (CodeMirror.cmpPos(r.anchor, r.head) === 0) return r;
      const lo = CodeMirror.cmpPos(r.anchor, r.head) < 0 ? r.anchor : r.head;
      const hi = lo === r.anchor ? r.head : r.anchor;
      const rtl = lineIsRtl(ed.getLine(r.head.line) || '');
      const p = goLeft === !rtl ? lo : hi; // LTR: Left→doc-start; RTL: Left→doc-end
      return { anchor: p, head: p };
    }));
    return;
  }

  const saved = ed.doc.direction;
  if (base !== saved) ed.doc.direction = base;
  try { return CodeMirror.commands[name](ed); }
  finally { if (base !== saved) ed.doc.direction = saved; }
}

function initEditor() {
  ['goCharLeft', 'goCharRight', 'goGroupLeft', 'goGroupRight', 'goLineStartSmart', 'goLineEnd']
    .forEach((n) => { CodeMirror.commands[n + 'DA'] = (ed) => dirAwareMotion(ed, n); });
  cm = CodeMirror($('#editor'), {
    value: '% open a file from the tree\n',
    mode: 'stex',
    lineNumbers: true,
    lineWrapping: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    styleSelectedText: true, // adds .CodeMirror-selectedtext so selected glyphs can go white
    rtlMoveVisually: true, // Left/Right follow visual position; see dirAwareMotion
    indentUnit: 2,
    tabSize: 2,
    theme: cmTheme(LS.get('theme', 'dark')),
    direction: 'ltr',
    extraKeys: {
      'Ctrl-S': () => saveFile(),
      'Cmd-S': () => saveFile(),
      'Ctrl-B': () => build(),
      'Cmd-B': () => build(),
      'Ctrl-Space': (ed) => ed.showHint({ hint: latexHint, completeSingle: false }),
      Tab: (ed) => (ed.somethingSelected() ? ed.indentSelection('add') : ed.replaceSelection('  ')),
      'Shift-Tab': (ed) => ed.indentSelection('subtract'),
      Home: 'goLineStartSmartDA',
      End: 'goLineEndDA',
      Left: 'goCharLeftDA',
      Right: 'goCharRightDA',
      'Ctrl-Left': 'goGroupLeftDA',
      'Ctrl-Right': 'goGroupRightDA',
    },
  });
  cm.setSize('100%', '100%');
  cm.on('renderLine', (ed, lh) => pinOrder(lh, lh.text));
  applyDir();
  markAllCmdLines();
  cm.on('change', () => { setDirty(isDirty()); });
  cm.on('changes', (ed, changes) => {
    let lo = Infinity;
    let hi = -1;
    for (const c of changes) {
      lo = Math.min(lo, c.from.line);
      hi = Math.max(hi, c.to.line, c.from.line + (c.text ? c.text.length - 1 : 0));
    }
    if (hi >= 0) markCmdRange(lo - 1, hi + 1);
  });
}
function refreshCM() { if (cm) setTimeout(() => cm.refresh(), 20); }

// A line's base direction is RTL only when it is a non-command line that carries
// at least one RTL (Persian/Arabic) character. Everything else is LTR: command
// lines (\section, \begin, …), empty lines, and lines of pure punctuation /
// braces / digits / Latin ("{", "(", "1.2", "abc", …). This drives the CSS
// class (alignment + `direction`), the pinned bidi order, and motion (above).
const CMD_LINE_RE = /^\s*\\/;
const HAS_FA_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
function lineIsRtl(s) {
  return HAS_FA_RE.test(s) && !CMD_LINE_RE.test(s);
}
function markCmdLine(i) {
  if (i < 0 || i >= cm.lineCount()) return;
  const text = cm.getLine(i) || '';
  const rtl = lineIsRtl(text);
  pinOrder(cm.getLineHandle(i), text);
  const info = cm.lineInfo(i);
  const has = !!(info && info.textClass && ('' + info.textClass).split(/\s+/).includes('rtl-line'));
  if (rtl && !has) {
    cm.addLineClass(i, 'text', 'rtl-line');
    cm.addLineClass(i, 'wrap', 'rtl-line-wrap');
  } else if (!rtl && has) {
    cm.removeLineClass(i, 'text', 'rtl-line');
    cm.removeLineClass(i, 'wrap', 'rtl-line-wrap');
  }
}
function markCmdRange(lo, hi) {
  cm.operation(() => {
    for (let i = Math.max(0, lo); i <= hi && i < cm.lineCount(); i++) markCmdLine(i);
  });
}
function markAllCmdLines() { markCmdRange(0, cm.lineCount() - 1); }

// ------------------------------------------------------------------ file state
let curf = { path: null, mtimeMs: 0, saved: '' };
const setDirty = (d) => app.classList.toggle('dirty', !!d);
const isDirty = () => !!(cm && curf.path && cm.getValue() !== curf.saved);

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
  cm.setValue(body.content);
  cm.clearHistory();
  cm.setCursor({ line: 0, ch: 0 });
  applyDir();
  markAllCmdLines();
  cm.focus();
  setDirty(false);
  $('#fileName').textContent = rel;
  LS.set('lastFile', rel);
  markActiveInTree(rel);
  if (/\.bib$/i.test(rel)) refreshBibKeys(body.content);
}

async function saveFile(force) {
  if (!curf.path) return;
  const text = cm.getValue();
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
      $('#pdf').src = src;
      $('#openPdf').href = src;
      $('#pdfWrap').classList.remove('empty-shown');
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
        const b = document.createElement('span');
        b.className = 'main-badge';
        b.textContent = 'main';
        b.title = 'set as main file';
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
  renderTree();
  populateMainSelect();
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
  const pick = saved && texs.includes(saved) ? saved
    : texs.find((p) => /(^|\/)PhDThesis\.tex$/i.test(p))
    || texs.find((p) => /main\.tex$/i.test(p)) || texs[0] || '';
  sel.value = pick;
  LS.set('main', pick);
}
function setMain(p) {
  $('#mainFile').value = p;
  LS.set('main', p);
  status200flash('main → ' + p);
}
$('#mainFile').addEventListener('change', (e) => LS.set('main', e.target.value));

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
  if (cm) cm.setOption('theme', cmTheme(next));
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
    cm.setValue('% open a file from the tree\n');
    cm.clearHistory();
    $('#fileName').textContent = 'no file open';
    setDirty(false);
    $('#pdf').removeAttribute('src');
    $('#pdfWrap').classList.add('empty-shown');
    await loadTree();
    const bib = findFirst(treeData, /references\.bib$/i) || findFirst(treeData, /\.bib$/i);
    if (bib) { try { refreshBibKeys((await api('/api/file?path=' + encodeURIComponent(bib))).body.content); } catch {} }
    status200flash('root → ' + body.rootName);
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
  $('#showAux').checked = LS.get('showAux', false);
  $('#workbench').style.setProperty('--sidebar-w', LS.get('sidebarW', 260) + 'px');
  const ef = LS.get('edFlex', 0.5);
  $('#panes').style.setProperty('--ed-flex', ef);
  $('#panes').style.setProperty('--pdf-flex', 1 - ef);
}

async function boot() {
  restoreLayout();
  if (typeof CodeMirror === 'undefined') {
    $('#editor').innerHTML = '<p style="padding:16px;color:#c66">CodeMirror failed to load — offline, or the CDN is blocked.</p>';
    setStatus('editor did not load', 'err');
    return;
  }
  initEditor();
  try {
    const { body } = await api('/api/health');
    if (body.lockRoot) $('#openFolder').style.display = 'none';
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
