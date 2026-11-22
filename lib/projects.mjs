// Откриване на проекти, колекции (папки със .md съдържание) и медийна папка.
// Работи за всеки статичен сайт: Astro, Hugo-подобни, Eleventy и др.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(__dirname, '..', 'local-admin.config.json');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.astro', '.svelte-kit', 'build', 'out',
  '.vercel', '.cache', '.next', '.nuxt', 'vendor', 'tmp',
]);

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    return {
      roots: Array.isArray(cfg.roots) ? cfg.roots : await defaultRoots(),
      projects: Array.isArray(cfg.projects) ? cfg.projects : [],
      lastProject: cfg.lastProject || null,
    };
  } catch {
    return { roots: await defaultRoots(), projects: [], lastProject: null };
  }
}

export async function saveConfig(cfg) {
  const clean = {
    roots: cfg.roots,
    projects: cfg.projects,
    lastProject: cfg.lastProject || null,
  };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8');
}

export async function defaultRoots() {
  const cands = [];
  if (process.env.USERPROFILE) {
    cands.push(path.join(process.env.USERPROFILE, 'Desktop'));
    cands.push(path.join(process.env.USERPROFILE, 'Documents'));
  }
  // WSL: Windows дискът е монтиран на /mnt/<буква>
  try {
    for (const drive of await fs.readdir('/mnt')) {
      const users = path.join('/mnt', drive, 'Users');
      let names;
      try { names = await fs.readdir(users); } catch { continue; }
      for (const u of names) {
        cands.push(path.join(users, u, 'Desktop'));
        cands.push(path.join(users, u, 'Documents'));
      }
    }
  } catch { /* не е WSL */ }
  const home = os.homedir();
  cands.push(path.join(home, 'Desktop'), path.join(home, 'Documents'), home);
  const good = [];
  for (const c of cands) {
    try { const st = await fs.stat(c); if (st.isDirectory()) good.push(c); } catch { /* няма такава */ }
  }
  return [...new Set(good)].slice(0, 12);
}

export async function isAstroProject(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps && Object.prototype.hasOwnProperty.call(deps, 'astro')) return true;
  } catch { /* няма package.json */ }
  for (const f of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts']) {
    try { await fs.access(path.join(dir, f)); return true; } catch { /* липсва */ }
  }
  return false;
}

// Търси Astro/статични проекти в зададените коренови папки (до 2 нива навътре).
export async function scanForProjects(cfg) {
  const known = new Set(cfg.projects.map(p => path.resolve(p.path)));
  const found = [];
  for (const root of cfg.roots) {
    let level1;
    try { level1 = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e1 of level1) {
      if (!e1.isDirectory() || SKIP_DIRS.has(e1.name) || e1.name.startsWith('.')) continue;
      const d1 = path.join(root, e1.name);
      if (known.has(path.resolve(d1))) continue;
      if (await isAstroProject(d1)) { found.push({ path: d1, name: e1.name }); continue; }
      let level2;
      try { level2 = await fs.readdir(d1, { withFileTypes: true }); } catch { continue; }
      for (const e2 of level2) {
        if (!e2.isDirectory() || SKIP_DIRS.has(e2.name) || e2.name.startsWith('.')) continue;
        const d2 = path.join(d1, e2.name);
        if (known.has(path.resolve(d2))) continue;
        if (await isAstroProject(d2)) found.push({ path: d2, name: e2.name });
      }
      if (found.length >= 30) break;
    }
    if (found.length >= 30) break;
  }
  for (const f of found) {
    if (!known.has(path.resolve(f.path))) {
      cfg.projects.push({ path: f.path, name: f.name, mediaDir: null, devUrl: '' });
      known.add(path.resolve(f.path));
    }
  }
  return found.length;
}

async function hasMdFiles(dir, depth) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) {
    if (e.isFile() && /\.(md|mdx|markdown)$/i.test(e.name)) return true;
    if (e.isDirectory() && depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      if (await hasMdFiles(path.join(dir, e.name), depth - 1)) return true;
    }
  }
  return false;
}

// Намира папки със съдържание (.md файлове) в даден проект.
// Поддържа: Astro content collections (src/content/* + content.config.ts),
// Hugo/Zola (content/), Eleventy-подобни (src/posts, src/blog…).
export async function discoverCollections(root) {
  const cands = new Set();
  const srcContent = path.join(root, 'src', 'content');

  // Astro: разбор на content.config.* за glob(...) папки
  for (const cf of ['src/content.config.ts', 'src/content.config.mjs', 'src/content.config.js',
    'src/content/config.ts', 'src/content/config.mjs']) {
    let txt;
    try { txt = await fs.readFile(path.join(root, cf), 'utf8'); } catch { continue; }
    const pats = [];
    for (const m of txt.matchAll(/glob\(\s*\{[\s\S]{0,200}?pattern\s*:\s*['"]([^'"]+)['"]/g)) pats.push(m[1]);
    for (const m of txt.matchAll(/glob\(\s*['"]([^'"]+)['"]/g)) pats.push(m[1]);
    for (const pat of pats) {
      const base = pat.split('/')[0];
      if (base && base !== '**' && !base.startsWith('.')) cands.add(path.join(srcContent, base));
    }
  }

  // Astro класическа структура: подпапки на src/content
  try {
    for (const e of await fs.readdir(srcContent, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) cands.add(path.join(srcContent, e.name));
    }
  } catch { /* няма src/content */ }

  // Общи структури за други генератори
  for (const rel of ['content', 'src/posts', 'src/blog', 'src/articles', 'posts', 'blog']) {
    cands.add(path.join(root, rel));
  }

  const out = [];
  const seen = new Set();
  const usedNames = new Set();
  for (const dir of cands) {
    if (!(await hasMdFiles(dir, 5))) continue;
    const rel = path.relative(root, dir).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || seen.has(rel)) continue;
    seen.add(rel);
    // кратко име = последният сегмент (posts, blog…); при сблъсък — по-дълъг път
    const parts = rel.split('/');
    let name = parts[parts.length - 1];
    if (usedNames.has(name)) name = parts.slice(-2).join('/');
    if (usedNames.has(name)) name = rel;
    usedNames.add(name);
    out.push({ name, dir: rel });
  }
  return out;
}

export async function resolveMediaDir(root, preferred) {
  if (preferred) {
    const abs = path.join(root, preferred);
    await fs.mkdir(abs, { recursive: true });
    return preferred;
  }
  const cands = [
    'public/images/uploads', 'public/uploads', 'public/images', 'public/img',
    'static/images/uploads', 'static/images', 'static/img', 'assets/images', 'public',
  ];
  for (const c of cands) {
    try { const st = await fs.stat(path.join(root, c)); if (st.isDirectory()) return c; } catch { /* липсва */ }
  }
  await fs.mkdir(path.join(root, 'public', 'uploads'), { recursive: true });
  return 'public/uploads';
}

/* ----- Разбор на схемата с полета от content.config.* (zod) ----- */

function splitTopLevel(s) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseZodFields(raw) {
  const fields = {};
  for (const part of splitTopLevel(raw)) {
    const m = part.match(/^\s*([\p{L}_$][\p{L}\p{N}_$]*)\s*:\s*([\s\S]+)$/u);
    if (!m) continue;
    const key = m[1].trim();
    const expr = m[2].trim();
    let type = 'string';
    let values = null;
    if (/z\.array/.test(expr)) type = 'array';
    else if (/boolean/.test(expr)) type = 'boolean';
    else if (/date/i.test(expr)) type = 'date';
    else if (/z\.image|\.image\s*\(/.test(expr)) type = 'image';
    else if (/z\.enum/.test(expr)) {
      type = 'select';
      const em = expr.match(/\[\s*([\s\S]*?)\]/);
      if (em) values = [...em[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
    } else if (/z\.object/.test(expr)) type = 'object';
    else if (/z\.number|z\.coerce\.number/.test(expr)) type = 'number';
    else if (/^(description|excerpt|summary|content|bodyContent|intro|lead|subtitle)$/i.test(key)) type = 'textarea';
    const optional = /\.optional\(\)/.test(expr) || /\.default\(/.test(expr) || /\.nullable\(\)/.test(expr);
    fields[key] = { type, optional, values };
  }
  return fields;
}

// Връща масив: [{ name, dir, fields: { ключ: {type, optional, values} } }]
// dir е нормализираната папка от loader glob (напр. 'src/content/posts').
export async function parseContentSchema(root) {
  const files = ['src/content.config.ts', 'src/content.config.mjs', 'src/content.config.js',
    'src/content/config.ts', 'src/content/config.mjs'];
  for (const f of files) {
    let txt;
    try { txt = await fs.readFile(path.join(root, f), 'utf8'); } catch { continue; }
    const out = [];
    const collRe = /([\p{L}_$][\p{L}\p{N}_$]*)\s*[:=]\s*defineCollection\s*\(/gu;
    let m;
    while ((m = collRe.exec(txt))) {
      const name = m[1];
      // скоби-баланс от отварящата ( до затварящата й )
      let i = m.index + m[0].length;
      let depth = 1;
      let e = i;
      while (e < txt.length && depth > 0) {
        const ch = txt[e];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        e++;
      }
      if (depth !== 0) continue;
      const block = txt.slice(i, e - 1);
      const bm = block.match(/base\s*:\s*['"]([^'"]+)['"]/);
      const dir = bm ? bm[1].replace(/^\.\//, '').replace(/\/+$/, '') : null;
      const sm = block.match(/schema\s*:\s*z\.object\s*\(/);
      if (!sm) continue;
      const sStart = block.indexOf(sm[0]) + sm[0].length;
      let d = 1;
      let e2 = sStart;
      while (e2 < block.length && d > 0) {
        const ch = block[e2];
        if (ch === '(') d++;
        else if (ch === ')') d--;
        e2++;
      }
      // съдържанието на z.object({ ... }) — махаме външните фигурни скоби
      let raw = block.slice(sStart, e2 - 1).trim();
      if (raw.startsWith('{') && raw.endsWith('}')) raw = raw.slice(1, -1);
      const fields = parseZodFields(raw);
      if (Object.keys(fields).length) out.push({ name, dir, fields });
    }
    if (out.length) return out;
  }
  return [];
}
