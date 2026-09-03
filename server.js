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
      version: (r.out.match(/Version[^\n]*/) || [''])[0].trim(),
    });
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
      `latexmk -${ENGINE} -shell-escape -interaction=nonstopmode -halt-on-error ` +
      `-file-line-error "${base}"`;
    const r = await run(cmd, cwd);
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
