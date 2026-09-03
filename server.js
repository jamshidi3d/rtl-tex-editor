#!/usr/bin/env node
/*
 * RTL-Web-Editor — local host process.
 *
 *   node server.js [--root <dir>] [--port <n>] [--engine xelatex|pdflatex|lualatex]
 *
 * Zero dependencies (Node >= 18 built-ins only). Binds to 127.0.0.1.
 * Serves ./public and a small file/compile API for the browser front-end.
 *
 * The compile step shells out to `latexmk -shell-escape` inside your project —
 * only run this on a folder you trust, and only on localhost.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const { spawn } = require('child_process');

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = parseInt(opt('port', '5199'), 10);
const ENGINE = opt('engine', 'xelatex');
const LOCK_ROOT = argv.includes('--lock-root');
const PUBLIC = path.join(__dirname, 'public');

let ROOT, ROOT_SEP;
function setRoot(p) {
  ROOT = path.resolve(p);
  ROOT_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
}
const cliRoot = opt('root', null);
const ROOT_FROM_CLI = !!cliRoot;
setRoot(cliRoot || process.cwd());

const PDFJS_VER = '3.11.174';
let _pdfWorkerJs = null; // cached pdf.js worker bytes (fetched once from cdnjs)

const HIDE_DIRS = new Set(['.git', 'node_modules', '.cache', '.svn', '.hg']);
const parentOf = (p) => {
  const d = path.dirname(p);
  return d === p ? null : d;
};
function winDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':' + path.sep;
    try { if (fs.existsSync(d)) out.push(d); } catch {}
  }
  return out;
}

// ---- helpers ------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function safeResolve(rel) {
  const p = path.resolve(ROOT, rel || '.');
  if (p !== ROOT && !p.startsWith(ROOT_SEP)) {
    const e = new Error('path escapes root');
    e.status = 403;
    throw e;
  }
  return p;
}
const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

async function buildTree(dir, depth, budget) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries = entries
    .filter((e) => !(e.isDirectory() && HIDE_DIRS.has(e.name)) && !e.name.startsWith('.git'))
    .sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name);
    });
  const out = [];
  for (const e of entries) {
    if (budget.n++ > 20000) break;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      const node = { name: e.name, path: relOf(abs), type: 'dir', children: [] };
      if (depth < 12) node.children = await buildTree(abs, depth + 1, budget);
      out.push(node);
    } else if (e.isFile()) {
      let size = 0;
      try {
        size = (await fsp.stat(abs)).size;
      } catch {}
      out.push({ name: e.name, path: relOf(abs), type: 'file', size });
    }
  }
  return out;
}

// --- SyncTeX (hand-parsed; no `synctex` binary exists on Windows TeX Live) -----
// A .synctex(.gz) is plain text: header (`Unit`, `Magnification`, `X/Y Offset`
// in sp), `Input:<tag>:<path>` lines naming the source files, box/leaf records
// `<type><tag>,<line>[,<col>]:<h>,<v>[:<W>,<H>,<D>]` (sp, `v` grows downward),
// and `{<page>` / `}<page>` bracketing each sheet.
const SYNCTEX_REC = /^([([<hvxkg$])(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;

function synctexParse(text) {
  const lines = text.split('\n');
  const inputs = new Map();
  let unit = 1, mag = 1000, xoff = 0, yoff = 0;
  // The header (Output/Magnification/Unit/X Offset/Y Offset) sits after the
  // full `Input:` list and just before `Content:` — scan until that marker.
  let inHeader = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^Input:(\d+):(.+?)\s*$/.exec(l))) {
      inputs.set(Number(m[1]), { raw: m[2], norm: m[2].replace(/\\/g, '/').toLowerCase() });
    } else if (inHeader) {
      if (l === 'Content:') inHeader = false;
      else if ((m = /^Unit:([\d.]+)/.exec(l))) unit = parseFloat(m[1]) || 1;
      else if ((m = /^Magnification:(\d+)/.exec(l))) mag = parseInt(m[1], 10) || 1000;
      else if ((m = /^X Offset:(-?\d+)/.exec(l))) xoff = parseInt(m[1], 10) || 0;
      else if ((m = /^Y Offset:(-?\d+)/.exec(l))) yoff = parseInt(m[1], 10) || 0;
    }
  }
  return { lines, inputs, unit, mag, xoff, yoff };
}

// Pick the Input tag for the source file we want. `want.rel` is already
// cwd-relative + '/'-joined + lowercased; xelatex records inputs as
// `<cwd>/./chapters/ch1.tex` (abs, '/'-joined, literal './'), so strip a
// leading './' and the compile cwd prefix before comparing tails.
function synctexResolveTag(inputs, want, cwdNorm) {
  const wRel = want.rel;
  const strip = (p) => {
    let s = p.replace(/^\.\//, '');
    if (cwdNorm && (s.startsWith(cwdNorm + '/./') || s.startsWith(cwdNorm + '/'))) {
      s = s.slice(cwdNorm.length + 1).replace(/^\.\//, '');
    }
    return s;
  };
  for (const [t, { norm }] of inputs) {
    if (strip(norm) === wRel || norm === want.abs || norm === './' + wRel) return t;
  }
  const byBase = [];
  for (const [t, { norm }] of inputs) if (norm.split('/').pop() === want.base) byBase.push(t);
  return byBase.length === 1 ? byBase[0] : null;
}

// Forward: source line -> { page, line, h, v, W, H, D, unit, mag, xoff, yoff }.
function synctexForward(text, want, wantLine) {
  const P = synctexParse(text);
  const tag = synctexResolveTag(P.inputs, want, want.cwdNorm);
  if (tag == null) return null;
  let page = 0;
  let best = null;
  for (const l of P.lines) {
    if (l.charCodeAt(0) === 123 /* { */) { const n = parseInt(l.slice(1), 10); if (Number.isFinite(n)) page = n; continue; }
    const m = SYNCTEX_REC.exec(l);
    if (!m || Number(m[2]) !== tag) continue;
    const rl = Number(m[3]);
    const d = Math.abs(rl - wantLine);
    const hasBox = m[7] != null;
    if (!best || d < best.d
        || (d === best.d && rl >= wantLine && best.rl < wantLine)
        || (d === best.d && hasBox && !best.hasBox)) {
      best = { d, rl, page, hasBox, h: +m[5], v: +m[6], W: m[7] != null ? +m[7] : null, H: m[8] != null ? +m[8] : null, D: m[9] != null ? +m[9] : null };
      if (d === 0 && hasBox) break;
    }
  }
  if (!best) return null;
  return {
    page: best.page, line: best.rl, h: best.h, v: best.v, W: best.W, H: best.H, D: best.D,
    unit: P.unit, mag: P.mag, xoff: P.xoff, yoff: P.yoff,
  };
}

// Reverse: (page, h_sp, v_sp) -> { tag, line, h, v }. Nearest record on that
// sheet by |dv| then |dh|; a record whose [v-H .. v+D] band contains v_sp wins.
function synctexReverse(text, wantPage, hSp, vSp) {
  const P = synctexParse(text);
  let page = 0;
  let best = null;
  for (const l of P.lines) {
    const c = l.charCodeAt(0);
    if (c === 123 /* { */) { const n = parseInt(l.slice(1), 10); if (Number.isFinite(n)) page = n; continue; }
    if (c === 125 /* } */) { if (page === wantPage) break; page = 0; continue; }
    if (page !== wantPage) continue;
    const m = SYNCTEX_REC.exec(l);
    if (!m) continue;
    const v = +m[6], h = +m[5];
    const H = m[8] != null ? +m[8] : 0;
    const D = m[9] != null ? +m[9] : 0;
    let dv = Math.abs(v - vSp);
    if (vSp >= v - H - 6553 && vSp <= v + D + 6553) dv -= 1e9; // band hit wins
    const dh = Math.abs(h - hSp);
    if (!best || dv < best.dv || (dv === best.dv && dh < best.dh)) {
      best = { dv, dh, tag: Number(m[2]), line: Number(m[3]), h, v };
    }
  }
  return best ? { tag: best.tag, line: best.line, h: best.h, v: best.v } : null;
}

async function readSynctexText(bpdf) {
  let gz;
  for (const gp of [bpdf + '.synctex.gz', bpdf + '.synctex']) {
    try { gz = await fsp.readFile(gp); break; } catch {}
  }
  if (!gz) return null;
  return gz[0] === 0x1f && gz[1] === 0x8b ? zlib.gunzipSync(gz).toString('latin1') : gz.toString('latin1');
}

function run(cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, timeout: 180000 });
    let out = '';
    const cap = (d) => {
      out += d.toString();
      if (out.length > 400000) out = out.slice(-400000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (err) => resolve({ code: -1, out: out + '\n' + err.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

// ---- routes -----------------------------------------------------------------
async function api(req, res, pathname, query) {
  if (pathname === '/api/health') {
    const r = await run('latexmk -v', ROOT);
    return json(res, 200, {
      root: ROOT,
      rootName: path.basename(ROOT) || ROOT,
      engine: ENGINE,
      rootFromCli: ROOT_FROM_CLI,
      lockRoot: LOCK_ROOT,
      latexmk: r.code === 0,
      synctex: r.code === 0, // we parse the .synctex.gz ourselves (latexmk builds with -synctex=1)
      version: (r.out.match(/Version[^\n]*/) || [''])[0].trim(),
    });
  }

  // Re-serve the pdf.js web worker from our own origin. cdnjs blocks a
  // cross-origin `new Worker(...)`, which would drop pdf.js to its slow
  // main-thread "fake worker". Fetched once, cached in memory (no disk write,
  // so .gitignore's public/vendor/ rule is untouched).
  if (pathname === '/api/pdfjs-worker' && req.method === 'GET') {
    if (!_pdfWorkerJs) {
      try {
        const w = await fetch(`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js`);
        if (!w.ok) throw new Error('HTTP ' + w.status);
        _pdfWorkerJs = Buffer.from(await w.arrayBuffer());
      } catch (e) {
        console.warn('[pdfjs-worker] fetch failed, pdf.js will use the main-thread fallback:', e.message);
        return send(res, 502, '// pdf.js worker fetch failed: ' + e.message,
          { 'Content-Type': 'text/javascript; charset=utf-8' });
      }
    }
    return send(res, 200, _pdfWorkerJs, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  }

  if (pathname === '/api/synctex' && req.method === 'GET') {
    const main = query.main;
    const file = query.file;
    const line = parseInt(query.line, 10);
    if (!main || !file || !Number.isFinite(line)) return json(res, 400, { error: 'need main, file, line' });
    const texAbs = safeResolve(main);
    const cwd = path.dirname(texAbs);
    const bpdf = path.join(cwd, path.basename(texAbs).replace(/\.tex$/i, ''));
    const srcAbs = safeResolve(file);
    const text = await readSynctexText(bpdf);
    if (!text) return json(res, 200, { ok: false, error: 'no .synctex.gz — build first' });
    let hit;
    try {
      hit = synctexForward(text, {
        abs: srcAbs.split(path.sep).join('/').toLowerCase(),
        rel: path.relative(cwd, srcAbs).split(path.sep).join('/').toLowerCase(),
        base: path.basename(srcAbs).toLowerCase(),
        cwdNorm: cwd.split(path.sep).join('/').toLowerCase(),
      }, line);
    } catch (e) {
      return json(res, 200, { ok: false, error: 'synctex parse: ' + e.message });
    }
    if (!hit) return json(res, 200, { ok: false, error: 'no record for that line' });
    return json(res, 200, {
      ok: true, page: hit.page, srcLine: hit.line,
      h: hit.h, v: hit.v, W: hit.W, H: hit.H, D: hit.D,
      unit: hit.unit, mag: hit.mag, xoff: hit.xoff, yoff: hit.yoff,
    });
  }

  if (pathname === '/api/synctex-reverse' && req.method === 'GET') {
    const main = query.main;
    const page = parseInt(query.page, 10);
    const hPt = parseFloat(query.h);
    const vPt = parseFloat(query.v);
    if (!main || !Number.isFinite(page) || !Number.isFinite(hPt) || !Number.isFinite(vPt)) {
      return json(res, 400, { error: 'need main, page, h, v' });
    }
    const texAbs = safeResolve(main);
    const cwd = path.dirname(texAbs);
    const bpdf = path.join(cwd, path.basename(texAbs).replace(/\.tex$/i, ''));
    const text = await readSynctexText(bpdf);
    if (!text) return json(res, 200, { ok: false, error: 'no .synctex.gz — build first' });
    let hit;
    try {
      const P = synctexParse(text);
      const SP = 65536, M = P.mag / 1000;
      const hSp = (hPt * SP / M - P.xoff) / P.unit;
      const vSp = (vPt * SP / M - P.yoff) / P.unit;
      const r = synctexReverse(text, page, hSp, vSp);
      if (!r) return json(res, 200, { ok: false, error: 'no record near that spot' });
      const inp = P.inputs.get(r.tag);
      if (!inp) return json(res, 200, { ok: false, error: 'unknown input tag' });
      let p = inp.raw.replace(/\\/g, '/').replace(/^\.\//, '');
      const abs = /^([a-zA-Z]:)?\//.test(p) ? path.resolve(p) : path.resolve(cwd, p);
      const rel = relOf(abs);
      if (rel.startsWith('..')) return json(res, 200, { ok: false, error: 'outside root' });
      hit = { file: rel, line: r.line };
    } catch (e) {
      return json(res, 200, { ok: false, error: 'synctex parse: ' + e.message });
    }
    return json(res, 200, { ok: true, file: hit.file, line: hit.line });
  }

  if (pathname === '/api/root' && req.method === 'POST') {
    if (LOCK_ROOT) return json(res, 403, { error: 'root switching disabled (--lock-root)' });
    const { path: p } = JSON.parse((await readBody(req)).toString() || '{}');
    if (!p) return json(res, 400, { error: 'no path given' });
    const abs = path.resolve(p);
    let st;
    try { st = await fsp.stat(abs); } catch { return json(res, 404, { error: 'folder not found' }); }
    if (!st.isDirectory()) return json(res, 400, { error: 'not a folder' });
    setRoot(abs);
    return json(res, 200, { ok: true, root: ROOT, rootName: path.basename(ROOT) || ROOT });
  }

  if (pathname === '/api/browse' && req.method === 'GET') {
    const base = query.path ? path.resolve(query.path) : ROOT;
    let st;
    try { st = await fsp.stat(base); } catch { return json(res, 404, { error: 'not found' }); }
    if (!st.isDirectory()) return json(res, 400, { error: 'not a folder' });
    let dirs = [];
    try {
      const ents = await fsp.readdir(base, { withFileTypes: true });
      dirs = ents
        .filter((e) => e.isDirectory() && !e.name.startsWith('$'))
        .map((e) => ({ name: e.name, path: path.join(base, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return json(res, 200, { path: base, parent: parentOf(base), sep: path.sep, dirs: [], error: 'unreadable' });
    }
    const parent = parentOf(base);
    const out = { path: base, parent, sep: path.sep, dirs };
    if (!parent && process.platform === 'win32') out.drives = winDrives();
    return json(res, 200, out);
  }

  if (pathname === '/api/tree') {
    const tree = await buildTree(ROOT, 0, { n: 0 });
    return json(res, 200, { root: ROOT, rootName: path.basename(ROOT) || ROOT, tree });
  }

  if (pathname === '/api/file') {
    const abs = safeResolve(query.path);
    if (req.method === 'GET') {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return json(res, 400, { error: 'not a file' });
      if (st.size > 5 * 1024 * 1024) return json(res, 413, { error: 'file too large (>5 MB)' });
      const content = await fsp.readFile(abs, 'utf8');
      return json(res, 200, { path: query.path, content, mtimeMs: st.mtimeMs });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (query.mtime && query.mtime !== 'force') {
        try {
          const cur = (await fsp.stat(abs)).mtimeMs;
          if (cur > Number(query.mtime) + 1)
            return json(res, 409, { conflict: true, mtimeMs: cur });
        } catch {}
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, body);
      const st = await fsp.stat(abs);
      return json(res, 200, { ok: true, mtimeMs: st.mtimeMs });
    }
    return json(res, 405, { error: 'method' });
  }

  if (pathname === '/api/pdf' && req.method === 'GET') {
    const abs = safeResolve(query.path);
    if (!abs.toLowerCase().endsWith('.pdf')) return json(res, 400, { error: 'not a pdf' });
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return json(res, 404, { error: 'pdf not found' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  if (pathname === '/api/compile' && req.method === 'POST') {
    const { main } = JSON.parse((await readBody(req)).toString() || '{}');
    if (!main) return json(res, 400, { error: 'no main file' });
    const abs = safeResolve(main);
    const cwd = path.dirname(abs);
    const base = path.basename(abs).replace(/\.tex$/i, '');
    const t0 = Date.now();
    const cmd =
      `latexmk -${ENGINE} -synctex=1 -shell-escape -interaction=nonstopmode -halt-on-error ` +
      `-file-line-error "${base}"`;
    let r = await run(cmd, cwd);
    // latexmk latches a previous failure and then refuses to rebuild ("gave an
    // error in previous invocation") even after the source is fixed — force one
    // real run to clear it (or to surface the actual LaTeX error).
    if (r.code !== 0 && /gave an error in previous invocation/i.test(r.out)) {
      r = await run(cmd.replace(/^latexmk /, 'latexmk -g '), cwd);
    }
    const pdfAbs = path.join(cwd, base + '.pdf');
    let pdfRel = null;
    try {
      await fsp.access(pdfAbs);
      pdfRel = relOf(pdfAbs);
    } catch {}
    return json(res, 200, {
      ok: r.code === 0 && !!pdfRel,
      code: r.code,
      log: r.out,
      pdf: pdfRel,
      durationMs: Date.now() - t0,
    });
  }

  return json(res, 404, { error: 'unknown endpoint' });
}

async function static_(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  try {
    const data = await fsp.readFile(abs);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  try {
    if (u.pathname.startsWith('/api/')) await api(req, res, u.pathname, u.query);
    else await static_(req, res, u.pathname);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RTL-Web-Editor  →  http://127.0.0.1:${PORT}`);
  console.log(`  root   : ${ROOT}`);
  console.log(`  engine : ${ENGINE}   (latexmk -${ENGINE} -shell-escape)`);
});
