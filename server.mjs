// Локален админ панел — HTTP сървър (само вградени модули на Node, без инсталации).
// Слуша само на 127.0.0.1 (никакъв достъп от мрежата) и работи САМО с папки,
// които са изрично добавени като проекти.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, saveConfig, isAstroProject, discoverCollections, resolveMediaDir, parseContentSchema,
} from './lib/projects.mjs';
import {
  splitFrontmatter, parseFm, serializeFm, assembleEntry, sanitizeSlug, isValidKey,
} from './lib/frontmatter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp)$/i;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|pdf|mp3|mp4|webm|ogg|wav)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', '.astro', '.trash-local-admin']);
const MAX_BODY = 40 * 1024 * 1024; // 40 MB (за качвани снимки в base64)

let config = null;

/* ---------- помощни ---------- */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function fail(res, code, message) { json(res, code, { error: message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Твърде голям запрос (над 40 MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('Невалиден JSON в запроса.'); }
}

// Път вътре в проекта — блокира излизане със ../
function safeJoin(root, rel) {
  const abs = path.resolve(root, String(rel || ''));
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('Пътят излиза извън проекта.');
  return abs;
}

function getProject(projPath) {
  const p = config.projects.find(x => path.resolve(x.path) === path.resolve(String(projPath || '')));
  if (!p) throw new Error('Проектът не е добавен в панела.');
  return p;
}

function projectRoot(p) { return path.resolve(p.path); }

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
};

/* ---------- файлове и колекции ---------- */

async function listMdFiles(dirAbs, depth) {
  const out = [];
  async function walk(dir, d) {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (d <= 0 || SKIP.has(e.name) || e.name.startsWith('.')) continue;
        await walk(path.join(dir, e.name), d - 1);
      } else if (e.isFile() && /\.(md|mdx|markdown)$/i.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  await walk(dirAbs, depth);
  return out.sort((a, b) => a.localeCompare(b, 'bg'));
}

function relInside(rootAbs, abs) {
  return path.relative(rootAbs, abs).split(path.sep).join('/');
}

async function findCollDir(root, collName) {
  const cols = await discoverCollections(root);
  const c = cols.find(c => c.name === collName || c.dir === collName);
  if (!c) throw new Error(`Не е намерена колекция „${collName}“.`);
  return c.dir;
}

function pickField(items, keys) {
  for (const k of keys) {
    const it = items.find(x => x.type === 'field' && x.key === k && !x.deleted);
    if (it && String(it.value).trim() !== '') return String(it.value);
  }
  return '';
}

/* ---------- API рутове ---------- */

async function handleApi(req, res, url) {
  const q = url.searchParams;
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/config') {
    json(res, 200, {
      roots: config.roots,
      projects: config.projects.map(p => ({ name: p.name, path: p.path, mediaDir: p.mediaDir || null, devUrl: p.devUrl || '' })),
      lastProject: config.lastProject,
    });
    return;
  }

  if (route === 'POST /api/config') {
    const b = await readJson(req);
    if (Array.isArray(b.roots)) {
      const good = [];
      for (const r of b.roots.slice(0, 20)) {
        try { const st = await fs.stat(String(r)); if (st.isDirectory()) good.push(String(r)); } catch { /* пропускаме */ }
      }
      config.roots = good;
    }
    if (typeof b.lastProject === 'string' || b.lastProject === null) {
      config.lastProject = b.lastProject && config.projects.some(p => path.resolve(p.path) === path.resolve(b.lastProject))
        ? b.lastProject : null;
    }
    if (b.project) {
      const p = getProject(b.project);
      if (typeof b.devUrl === 'string') p.devUrl = b.devUrl.trim().replace(/\/+$/, '');
      if (typeof b.mediaDir === 'string' && b.mediaDir.trim()) {
        const rel = b.mediaDir.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        safeJoin(projectRoot(p), rel); // валидация
        p.mediaDir = rel;
        await fs.mkdir(safeJoin(projectRoot(p), rel), { recursive: true });
      }
    }
    await saveConfig(config);
    json(res, 200, { ok: true });
    return;
  }

  if (route === 'POST /api/projects/add') {
    const b = await readJson(req);
    const dir = path.resolve(String(b.path || '').trim());
    if (!dir || dir === path.sep) throw new Error('Задайте път до папка.');
    let st;
    try { st = await fs.stat(dir); } catch { throw new Error('Папката не съществува: ' + dir); }
    if (!st.isDirectory()) throw new Error('Това не е папка: ' + dir);
    if (config.projects.some(p => path.resolve(p.path) === dir)) throw new Error('Проектът вече е добавен.');
    const cols = await discoverCollections(dir);
    if (cols.length === 0) {
      throw new Error('В тази папка не е намерено .md съдържание (напр. src/content/… или content/…).');
    }
    const proj = { path: dir, name: path.basename(dir), mediaDir: null, devUrl: '' };
    config.projects.push(proj);
    await saveConfig(config);
    json(res, 200, { ok: true, project: proj, collections: cols });
    return;
  }

  if (route === 'POST /api/projects/remove') {
    const b = await readJson(req);
    const dir = path.resolve(String(b.path || ''));
    config.projects = config.projects.filter(p => path.resolve(p.path) !== dir);
    if (config.lastProject && path.resolve(config.lastProject) === dir) config.lastProject = null;
    await saveConfig(config);
    json(res, 200, { ok: true });
    return;
  }

  if (route === 'POST /api/projects/scan') {
    const { scanForProjects } = await import('./lib/projects.mjs');
    const n = await scanForProjects(config);
    await saveConfig(config);
    json(res, 200, { ok: true, found: n, projects: config.projects.map(p => ({ name: p.name, path: p.path })) });
    return;
  }

  // Списък с колекции (папки със .md съдържание) в проекта
  if (route === 'GET /api/collections') {
    const p = getProject(q.get('path'));
    const cols = await discoverCollections(projectRoot(p));
    json(res, 200, { collections: cols });
    return;
  }

  // Схема с полетата на колекциите (от content.config.ts, zod)
  if (route === 'GET /api/schema') {
    const p = getProject(q.get('path'));
    const collections = await parseContentSchema(projectRoot(p));
    json(res, 200, { collections });
    return;
  }

  // Списък със статии в колекция
  if (route === 'GET /api/entries') {
    const p = getProject(q.get('path'));
    const root = projectRoot(p);
    const collDir = await findCollDir(root, q.get('collection'));
    const collAbs = safeJoin(root, collDir);
    const files = await listMdFiles(collAbs, 6);
    const entries = [];
    for (const f of files) {
      let txt;
      try { txt = await fs.readFile(f, 'utf8'); } catch { continue; }
      const { fm, had } = splitFrontmatter(txt);
      const items = had ? parseFm(fm) : [];
      const stat = await fs.stat(f);
      const inColl = relInside(collAbs, f);
      const cat = path.dirname(inColl).split(path.sep).join('/');
      entries.push({
        file: inColl,
        category: cat === '.' ? '' : cat,
        slug: path.basename(f).replace(/\.(md|mdx|markdown)$/i, ''),
        title: pickField(items, ['title', 'name']) || path.basename(f),
        draft: (() => {
          const d = items.find(x => x.type === 'field' && x.key === 'draft');
          if (d) return /^(true|yes|1)$/i.test(String(d.value).trim());
          const pu = items.find(x => x.type === 'field' && x.key === 'published');
          if (pu) return !/^(true|yes|1)$/i.test(String(pu.value).trim());
          return false;
        })(),
        date: pickField(items, ['pubDate', 'date', 'publishDate', 'publishedDate', 'publish_date']),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    }
    entries.sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date);
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return a.title.localeCompare(b.title, 'bg');
    });
    json(res, 200, { entries });
    return;
  }

  // Една статия: frontmatter елементи + тяло + подсказка за полета
  if (route === 'GET /api/entry') {
    const p = getProject(q.get('path'));
    const root = projectRoot(p);
    const collDir = await findCollDir(root, q.get('collection'));
    const collAbs = safeJoin(root, collDir);
    const abs = safeJoin(collAbs, q.get('file'));
    if (!(await exists(abs))) throw new Error('Файлът не съществува.');
    const txt = await fs.readFile(abs, 'utf8');
    const { fm, body, had } = splitFrontmatter(txt);
    const items = had ? parseFm(fm) : [];
    // подсказка: кои полета се срещат в другите файлове на колекцията
    const counts = new Map();
    const siblings = await listMdFiles(collAbs, 6);
    for (const s of siblings.slice(0, 80)) {
      if (path.resolve(s) === path.resolve(abs)) continue;
      let st;
      try { st = await fs.readFile(s, 'utf8'); } catch { continue; }
      const sf = splitFrontmatter(st);
      if (!sf.had) continue;
      for (const it of parseFm(sf.fm)) {
        if (it.type === 'field') counts.set(it.key, (counts.get(it.key) || 0) + 1);
      }
    }
    const hint = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    json(res, 200, { file: relInside(collAbs, abs), items, body, hint });
    return;
  }

  // Запис: нов файл, редакция, смяна на категория/слъг (преместване)
  if (route === 'POST /api/save') {
    const b = await readJson(req);
    const p = getProject(b.path);
    const root = projectRoot(p);
    const collDir = await findCollDir(root, String(b.collection || ''));
    const collAbs = safeJoin(root, collDir);
    const slug = sanitizeSlug(String(b.slug || ''));
    if (!slug) throw new Error('Липсва име на файл (слъг).');
    const catParts = String(b.category || '').split('/').map(s => sanitizeSlug(s)).filter(Boolean);
    const newRel = path.posix.join(...catParts, `${slug}.md`);
    const newAbs = safeJoin(collAbs, newRel);

    // валидация на елементите
    const items = Array.isArray(b.items) ? b.items : [];
    for (const it of items) {
      if (it.type === 'raw') {
        if (String(it.text).split('\n').some(l => /^---/.test(l))) throw new Error('Невалидно разширено поле.');
        continue;
      }
      if (it.type === 'field') {
        if (!isValidKey(it.key)) throw new Error(`Невалидно име на поле: ${String(it.key).slice(0, 40)}`);
        it.value = String(it.value == null ? '' : it.value);
        if (it.value.includes('\n') && it.kind !== 'block') it.kind = 'block';
      }
    }

    if (b.file) {
      const oldAbs = safeJoin(collAbs, String(b.file));
      if (!(await exists(oldAbs))) throw new Error('Файлът вече не съществува (преместен или изтрит?).');
      if (path.resolve(oldAbs) !== path.resolve(newAbs)) {
        if ((await exists(newAbs)) && !b.overwriteOk) {
          fail(res, 409, `Вече съществува файл „${newRel}“. Запишете с друго име или потвърдете замяната.`);
          return;
        }
        await fs.mkdir(path.dirname(newAbs), { recursive: true });
        await fs.rename(oldAbs, newAbs);
      }
      await fs.writeFile(newAbs, assembleEntry(serializeFm(items), b.body), 'utf8');
      json(res, 200, { ok: true, file: newRel, absPath: newAbs });
      return;
    }

    if ((await exists(newAbs)) && !b.overwriteOk) {
      fail(res, 409, `Вече съществува файл „${newRel}“. Изберете друго име.`);
      return;
    }
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.writeFile(newAbs, assembleEntry(serializeFm(items), b.body), 'utf8');
    json(res, 200, { ok: true, file: newRel, absPath: newAbs });
    return;
  }

  // Изтриване → в кош (.trash-local-admin в проекта), не директно изтриване
  if (route === 'POST /api/delete') {
    const b = await readJson(req);
    const p = getProject(b.path);
    const root = projectRoot(p);
    const collDir = await findCollDir(root, String(b.collection || ''));
    const collAbs = safeJoin(root, collDir);
    const abs = safeJoin(collAbs, String(b.file || ''));
    if (!(await exists(abs))) throw new Error('Файлът не съществува.');
    const trash = safeJoin(root, '.trash-local-admin');
    await fs.mkdir(trash, { recursive: true });
    const base = path.basename(abs);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(trash, `${stamp}-${base}`);
    let finalDest = dest;
    let n = 1;
    while (await exists(finalDest)) { finalDest = dest.replace(/(\.md)$/i, `-${n}$1`); n++; }
    await fs.rename(abs, finalDest);
    json(res, 200, { ok: true, trash: relInside(root, finalDest) });
    return;
  }

  // Качване на изображение/файл (base64 в JSON)
  if (route === 'POST /api/upload') {
    const b = await readJson(req);
    const p = getProject(b.path);
    const root = projectRoot(p);
    if (!config.projects.includes(p)) throw new Error('Вътрешна грешка.');
    const mediaDir = p.mediaDir || await resolveMediaDir(root, null);
    if (!p.mediaDir) { p.mediaDir = mediaDir; await saveConfig(config); }
    const mediaAbs = safeJoin(root, mediaDir);
    await fs.mkdir(mediaAbs, { recursive: true });

    let name = path.basename(String(b.filename || 'file')).replace(/\\/g, '/');
    name = name.split('/').pop() || 'file';
    name = name.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}\-._]/gu, '');
    if (!name || name === '.' || name === '..') name = 'file';
    if (!MEDIA_EXT.test(name)) name += '.jpg';

    let dest = path.join(mediaAbs, name);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let n = 1;
    while (await exists(dest)) { dest = path.join(mediaAbs, `${stem}-${n}${ext}`); n++; }
    const finalName = path.basename(dest);

    const data = String(b.data || '');
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) throw new Error('Празен файл.');
    await fs.writeFile(dest, buf);

    const rel = relInside(mediaAbs, dest);
    const segs = mediaDir.split('/').filter(Boolean);
    const sitePath = segs[0] === 'public' || segs[0] === 'static'
      ? '/' + [...segs.slice(1), rel].filter(Boolean).join('/')
      : '/' + [...segs, rel].filter(Boolean).join('/');
    json(res, 200, {
      ok: true,
      name: finalName,
      mediaRel: rel,
      sitePath,
      url: `/api/media?path=${encodeURIComponent(p.path)}&file=${encodeURIComponent(rel)}`,
    });
    return;
  }

  // Списък на качените файлове
  if (route === 'GET /api/images') {
    const p = getProject(q.get('path'));
    const root = projectRoot(p);
    const mediaDir = p.mediaDir || await resolveMediaDir(root, null);
    if (!p.mediaDir) { p.mediaDir = mediaDir; await saveConfig(config); }
    const mediaAbs = safeJoin(root, mediaDir);
    if (!(await exists(mediaAbs))) { json(res, 200, { mediaDir, images: [] }); return; }
    const files = [];
    async function walk(dir, d) {
      let ents;
      try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isDirectory() && d > 0 && !e.name.startsWith('.')) await walk(path.join(dir, e.name), d - 1);
        else if (e.isFile() && IMAGE_EXT.test(e.name)) files.push(path.join(dir, e.name));
      }
    }
    await walk(mediaAbs, 3);
    const segs = mediaDir.split('/').filter(Boolean);
    const images = files.map(f => {
      const rel = relInside(mediaAbs, f);
      return {
        name: path.basename(f),
        mediaRel: rel,
        sitePath: segs[0] === 'public' || segs[0] === 'static'
          ? '/' + [...segs.slice(1), rel].filter(Boolean).join('/')
          : '/' + [...segs, rel].filter(Boolean).join('/'),
        url: `/api/media?path=${encodeURIComponent(p.path)}&file=${encodeURIComponent(rel)}`,
        mtime: null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'bg'));
    json(res, 200, { mediaDir, images });
    return;
  }

  // Сервизиране на медиен файл (за прегледа в панела)
  if (route === 'GET /api/media') {
    const p = getProject(q.get('path'));
    const root = projectRoot(p);
    let abs = null;
    if (q.get('file')) {
      const mediaDir = p.mediaDir || await resolveMediaDir(root, null);
      abs = safeJoin(safeJoin(root, mediaDir), q.get('file'));
    } else if (q.get('site')) {
      const site = String(q.get('site')).replace(/^\/+/, '');
      const mediaDir = p.mediaDir || 'public/uploads';
      const segs = mediaDir.split('/').filter(Boolean);
      if (segs[0] === 'public' || segs[0] === 'static') {
        abs = safeJoin(safeJoin(root, segs[0]), site);
        if (!(await exists(abs))) {
          const alt = safeJoin(safeJoin(root, mediaDir), site);
          if (await exists(alt)) abs = alt;
        }
      } else {
        abs = safeJoin(safeJoin(root, mediaDir), site);
      }
    }
    if (!abs || !(await exists(abs)) || !MEDIA_EXT.test(abs)) throw new Error('Файлът не е намерен или типът не е позволен.');
    const buf = await fs.readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return;
  }

  fail(res, 404, 'Непознат API адрес.');
}

/* ---------- статични файлове (UI) ---------- */

async function serveStatic(res, url) {
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.resolve(PUBLIC_DIR, '.' + file);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) { fail(res, 403, 'Забранено.'); return; }
  if (!(await exists(file)) || !file.startsWith(PUBLIC_DIR)) {
    fail(res, 404, 'Не е намерено.');
    return;
  }
  const buf = await fs.readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/* ---------- стартиране ---------- */

export async function startServer(cfg, port) {
  config = cfg;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(res, url);
    } catch (err) {
      console.error('  Грешка:', err.message);
      if (!res.headersSent) fail(res, 500, err.message || 'Вътрешна грешка.');
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

export { isAstroProject };
export const __file = fileURLToPath(import.meta.url);
