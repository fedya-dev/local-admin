/* Локален админ панел — клиентска логика (без зависимости) */
'use strict';

/* ---------- състояние ---------- */
const S = {
  config: null,
  project: null,        // обект {name, path, mediaDir, devUrl}
  collections: [],
  collection: null,     // име на текущата колекция
  collectionDir: null,  // път на колекцията (напр. src/content/posts)
  schema: [],           // от content.config.ts: [{name, dir, fields}]
  entries: [],
  file: null,           // текущ файл (rel вътре в колекцията)
  items: [],            // работно копие на frontmatter елементите
  body: '',
  hint: [],
  dirty: false,
  slugTouched: false,
  imgTarget: null,      // null → вмъкни в текста; {item} → стойност на поле
  lastAbsPath: null,
};

/* ---------- помощни ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* празен отговор */ }
  if (!res.ok) throw new Error(data.error || `Грешка ${res.status}`);
  return data;
}
const GET = p => api(p);
const POST = (p, body) => api(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sanitizeSlug(name) {
  let s = String(name || '').trim();
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/[^\p{L}\p{N}\-.~]+/gu, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^[.\-]+/, '').replace(/[.\-]+$/, '');
  return s;
}

function setDirty(v) {
  S.dirty = v;
  $('saveBtn').classList.toggle('attention', v);
  $('saveHint').textContent = v ? '● Незаписани промени (Ctrl+S за запис)' : '';
  if (v) $('saveBar').hidden = true;
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('Копирано: ' + t, 2200);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Копирано: ' + t, 2200); } catch { toast('Маркирай и копирай: ' + t); }
    ta.remove();
  }
}

/* ---------- мини Markdown рендер (за Преглед) ---------- */
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${src}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}

function md2html(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(esc(buf.join(' ')))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => `<th>${inline(esc(c))}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${inline(esc(c))}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${buf.map(x => `<li>${inline(esc(x))}</li>`).join('')}</${tag}>`);
      continue;
    }
    const buf = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i])
      && !/^(```|#{1,6}\s|>|\s*([-*+]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(esc(buf.join(' ')))}</p>`);
  }
  return out.join('\n');
}

function renderPreview() {
  let html = md2html($('bodyArea').value);
  if (S.project) {
    const base = `/api/media?path=${encodeURIComponent(S.project.path)}&site=`;
    html = html.replace(/src="(\/[^"]+)"/g, (_, src) => `src="${base}${encodeURIComponent(src)}"`);
  }
  $('preview').innerHTML = html;
}

/* ---------- оцветяване на Markdown в редактора (слой под прозрачния текст) ---------- */
function highlightInline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<span class="hl-code">${c}</span>`); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
    '<span class="hl-marker">![</span>$1<span class="hl-marker">](</span><span class="hl-link">$2</span><span class="hl-marker">)</span>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<span class="hl-link">$1</span><span class="hl-marker">($2)</span>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<span class="hl-bold">$1</span>');
  s = s.replace(/\*([^*]+)\*/g, '<span class="hl-italic">$1</span>');
  s = s.replace(/~~([^~]+)~~/g, '<span class="hl-strike">$1</span>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}

function highlightMd(src) {
  const out = [];
  let fence = false;
  for (const line of String(src).split('\n')) {
    const e = esc(line);
    if (/^\s*```/.test(line)) { fence = !fence; out.push(`<span class="hl-fence">${e}</span>`); continue; }
    if (fence) { out.push(`<span class="hl-codeblock">${e}</span>`); continue; }
    const h = line.match(/^(#{1,6})\s/);
    if (h) { out.push(`<span class="hl-head${h[1].length === 1 ? ' hl-h1' : ''}">${e}</span>`); continue; }
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      out.push(e.replace(/^(\s*)([-*+]|\d+\.)(\s)/, '$1<span class="hl-marker">$2</span>$3'));
      continue;
    }
    if (/^>\s?/.test(line)) { out.push(`<span class="hl-quote">${e}</span>`); continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push(`<span class="hl-hr">${e}</span>`); continue; }
    out.push(highlightInline(e));
  }
  return out.join('\n') + '\n';
}

function renderHl() {
  const ta = $('bodyArea');
  const hl = $('hlLayer');
  hl.innerHTML = highlightMd(ta.value);
  syncHl();
}

function syncHl() {
  const ta = $('bodyArea');
  const hl = $('hlLayer');
  if (hl.scrollTop !== ta.scrollTop) hl.scrollTop = ta.scrollTop;
  if (hl.scrollLeft !== ta.scrollLeft) hl.scrollLeft = ta.scrollLeft;
}

/* ---------- проекти и схема ---------- */
async function loadConfig() {
  S.config = await GET('/api/config');
  renderProjectSelect();
}

function renderProjectSelect() {
  const sel = $('projectSelect');
  sel.innerHTML = '';
  if (!S.config.projects.length) {
    const o = document.createElement('option');
    o.textContent = '— няма добавени проекти —';
    sel.appendChild(o);
  }
  for (const p of S.config.projects) {
    const o = document.createElement('option');
    o.value = p.path;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  const last = S.config.lastProject;
  if (last && S.config.projects.some(p => p.path === last)) sel.value = last;
}

async function selectProject(path) {
  if (S.dirty && !confirm('Има незаписани промени. Напускате ли без запис?')) return;
  S.project = S.config.projects.find(p => p.path === path) || null;
  S.collections = [];
  S.collection = null;
  S.collectionDir = null;
  S.schema = [];
  S.entries = [];
  S.file = null;
  setDirty(false);
  $('devUrlInput').value = S.project ? (S.project.devUrl || '') : '';
  updateOpenSite();
  if (!S.project) { clearSidebar(); showWelcome('Избери или добави проект, за да почнеш.'); return; }
  document.title = `${S.project.name} · Локален админ`;
  await POST('/api/config', { lastProject: S.project.path });
  try {
    const cols = await GET(`/api/collections?path=${encodeURIComponent(S.project.path)}`);
    S.collections = cols.collections;
  } catch (e) { toast(e.message); }
  try {
    const sh = await GET(`/api/schema?path=${encodeURIComponent(S.project.path)}`);
    S.schema = sh.collections || [];
  } catch { S.schema = []; }
  renderCollectionTabs();
  if (S.collections.length) await selectCollection(S.collections[0].name);
  else { clearSidebar(); showWelcome('В проекта не е намерена колекция със .md файлове.'); }
}

function schemaForCollection() {
  if (!S.collectionDir) return null;
  const c = S.schema.find(x => x.dir === S.collectionDir)
    || S.schema.find(x => x.dir && S.collectionDir.endsWith(x.dir))
    || S.schema.find(x => x.name === S.collection);
  return c ? c.fields : null;
}

function updateOpenSite() {
  const a = $('openSite');
  const u = $('devUrlInput').value.trim();
  a.style.display = u ? '' : 'none';
  a.href = u || '#';
}

function showWelcome(msg) {
  $('editor').hidden = true;
  $('welcome').hidden = false;
  const w = $('welcome');
  const note = w.querySelector('.note');
  if (msg) {
    if (note) note.remove();
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = msg;
    w.appendChild(p);
  } else if (note) note.remove();
}

function clearSidebar() {
  $('collectionTabs').innerHTML = '';
  $('entryList').innerHTML = '';
}

/* ---------- колекции и списък ---------- */
function renderCollectionTabs() {
  const box = $('collectionTabs');
  box.innerHTML = '';
  for (const c of S.collections) {
    const b = document.createElement('button');
    b.className = 'tab' + (c.name === S.collection ? ' active' : '');
    b.textContent = c.name;
    b.title = c.dir;
    b.onclick = () => selectCollection(c.name);
    box.appendChild(b);
  }
}

async function selectCollection(name) {
  if (S.dirty && !confirm('Има незаписани промени. Напускате ли без запис?')) return;
  S.collection = name;
  const c = S.collections.find(x => x.name === name);
  S.collectionDir = c ? c.dir : null;
  S.file = null;
  setDirty(false);
  renderCollectionTabs();
  showWelcome();
  await loadEntries();
}

async function loadEntries() {
  try {
    const d = await GET(`/api/entries?path=${encodeURIComponent(S.project.path)}&collection=${encodeURIComponent(S.collection)}`);
    S.entries = d.entries;
    renderList();
  } catch (e) { toast(e.message); }
}

function renderList() {
  const q = $('searchBox').value.trim().toLowerCase();
  const ul = $('entryList');
  ul.innerHTML = '';
  for (const e of S.entries) {
    const hay = `${e.title} ${e.slug} ${e.category}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const li = document.createElement('li');
    li.className = 'entry' + (S.file && S.file === e.file ? ' active' : '');
    const meta = [e.date, e.category].filter(Boolean).join(' • ');
    li.innerHTML = `<div class="t">${esc(e.title)}${e.draft ? ' <span class="badge">чернова</span>' : ''}</div>`
      + (meta ? `<div class="m">${esc(meta)}</div>` : '');
    li.onclick = () => openEntry(e.file);
    ul.appendChild(li);
  }
  if (!ul.children.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? 'Няма съвпадения.' : 'Няма статии — създай нова.';
    ul.appendChild(li);
  }
}

/* ---------- полета: имена и типове ---------- */
const BOOL_KEYS = /^(draft|published|featured)$/i;
const DATE_KEYS = /^(pubDate|date|publishDate|publishedDate|publish_date|updatedDate|updated)$/i;
const LIST_KEYS = /(tags|categories|keywords|authors)$/i;
const IMAGE_KEYS = /^(heroImage|hero_image|image|coverImage|cover|cover_image|thumbnail|ogImage|og_image|featuredImage|previewImage)$/i;
const TEXTAREA_KEYS = /^(description|excerpt|summary|intro|lead|subtitle|seoDescription|seo_description)$/i;

const BG_LABELS = {
  title: 'Заглавие', description: 'Описание', excerpt: 'Извадка', summary: 'Резюме',
  subtitle: 'Подзаглавие', intro: 'Въведение', lead: 'Увод',
  pubDate: 'Дата на публикуване', date: 'Дата', publishDate: 'Дата на публикуване',
  publishedDate: 'Дата на публикуване', publish_date: 'Дата на публикуване',
  updatedDate: 'Обновено на', updated: 'Обновено на',
  draft: 'Чернова', published: 'Публикувано', featured: 'Избрана',
  tags: 'Етикети', categories: 'Категории', keywords: 'Ключови думи',
  authors: 'Автори', author: 'Автор',
  seoTitle: 'SEO заглавие', seoDescription: 'SEO описание', seo_description: 'SEO описание',
  seo: 'SEO настройки (YAML)', slug: 'Слъг (URL)', canonical: 'Каноничен URL',
  heroImage: 'Херо снимка', hero_image: 'Херо снимка', image: 'Снимка',
  cover: 'Корична снимка', coverImage: 'Корична снимка', cover_image: 'Корична снимка',
  thumbnail: 'Миниатюра', ogImage: 'OG снимка', og_image: 'OG снимка',
  featuredImage: 'Водеща снимка', previewImage: 'Снимка за преглед',
  alt: 'Алт текст на снимка', rating: 'Рейтинг', layout: 'Шаблон', lang: 'Език',
};

const COMMON_FIELDS = ['title', 'description', 'pubDate', 'updatedDate', 'draft', 'featured',
  'tags', 'categories', 'slug', 'seoTitle', 'seoDescription', 'heroImage', 'image', 'author', 'keywords'];

function fieldLabel(key) { return BG_LABELS[key] || key; }

function guessType(key) {
  if (DATE_KEYS.test(key)) return 'date';
  if (LIST_KEYS.test(key)) return 'array';
  if (BOOL_KEYS.test(key)) return 'boolean';
  if (IMAGE_KEYS.test(key)) return 'image';
  if (TEXTAREA_KEYS.test(key)) return 'textarea';
  return 'string';
}

function fieldType(key) {
  const schema = schemaForCollection();
  if (schema && schema[key]) return schema[key];
  return { type: guessType(key), optional: true, values: null };
}

const TYPE_NAMES = {
  string: 'текст', textarea: 'текст (дълъг)', date: 'дата', boolean: 'да/не',
  array: 'списък', image: 'снимка', select: 'избор', number: 'число', object: 'YAML обект',
};

/* ---------- редактор: полета ---------- */
function fieldControl(item) {
  const meta = fieldType(item.key);
  const wrap = document.createElement('div');
  wrap.className = 'fieldRow' + (meta.type === 'image' ? ' isImage' : '');
  const lbl = document.createElement('label');
  const nameSpan = document.createElement('span');
  nameSpan.className = 'fName';
  nameSpan.textContent = fieldLabel(item.key);
  const keySpan = document.createElement('span');
  keySpan.className = 'fKey';
  keySpan.textContent = item.key;
  lbl.append(nameSpan, keySpan);
  wrap.appendChild(lbl);

  let ctl;

  const bindText = (el) => {
    el.value = item.value;
    el.oninput = () => {
      item.value = el.value;
      setDirty(true);
      if (item.key === 'title') $('entryTitle').textContent = el.value.trim() || S.file || '';
    };
    return el;
  };

  if (meta.type === 'boolean') {
    ctl = document.createElement('input');
    ctl.type = 'checkbox';
    ctl.className = 'boolCtl';
    ctl.checked = /^(true|yes|1)$/i.test(String(item.value).trim());
    ctl.onchange = () => { item.value = ctl.checked ? 'true' : 'false'; setDirty(true); };
  } else if (meta.type === 'select' && Array.isArray(meta.values) && meta.values.length) {
    ctl = document.createElement('select');
    for (const v of meta.values) {
      const o = document.createElement('option');
      o.value = o.textContent = v;
      ctl.appendChild(o);
    }
    if (![...ctl.options].some(o => o.value === String(item.value)) && String(item.value).trim()) {
      const o = document.createElement('option');
      o.value = o.textContent = String(item.value);
      ctl.appendChild(o);
    }
    ctl.value = String(item.value);
    ctl.onchange = () => { item.value = ctl.value; setDirty(true); };
  } else if (meta.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(item.value).trim())) {
    ctl = document.createElement('input');
    ctl.type = 'date';
    bindText(ctl);
  } else if (meta.type === 'image') {
    ctl = document.createElement('input');
    ctl.type = 'text';
    ctl.placeholder = '/uploads/снимка.jpg';
    bindText(ctl);
    const pick = document.createElement('button');
    pick.className = 'ghost small pickImg';
    pick.textContent = '🖼 Избери';
    pick.title = 'Избери или качи снимка за това поле';
    pick.onclick = () => openImgModal({ item });
    wrap.appendChild(pick);
  } else if (item.kind === 'block' || meta.type === 'textarea') {
    ctl = document.createElement('textarea');
    ctl.rows = meta.type === 'textarea' ? 2 : 3;
    bindText(ctl);
  } else {
    ctl = document.createElement('input');
    ctl.type = 'text';
    if (meta.type === 'number') ctl.inputMode = 'decimal';
    if (meta.type === 'date') ctl.placeholder = 'YYYY-MM-DD';
    if (item.kind === 'array' || meta.type === 'array') ctl.placeholder = 'стойности, разделени със запетая';
    bindText(ctl);
  }
  wrap.appendChild(ctl);

  const del = document.createElement('button');
  del.className = 'delField';
  del.textContent = '✕';
  del.title = 'Премахни полето';
  del.onclick = () => {
    if (!confirm(`Да премахна ли полето „${item.key}“ от тази статия?`)) return;
    item.deleted = true;
    wrap.remove();
    setDirty(true);
  };
  wrap.appendChild(del);
  return wrap;
}

function rawControl(item) {
  const wrap = document.createElement('div');
  wrap.className = 'fieldRow raw';
  const lbl = document.createElement('label');
  const nameSpan = document.createElement('span');
  nameSpan.className = 'fName';
  nameSpan.textContent = 'Разширено (YAML)';
  const keySpan = document.createElement('span');
  keySpan.className = 'fKey';
  keySpan.textContent = item.text.split('\n')[0].replace(/:.*$/, '') || '—';
  lbl.append(nameSpan, keySpan);
  wrap.appendChild(lbl);
  const ctl = document.createElement('textarea');
  ctl.rows = Math.max(2, item.text.split('\n').length + 1);
  ctl.value = item.text;
  ctl.oninput = () => { item.text = ctl.value; setDirty(true); };
  wrap.appendChild(ctl);
  return wrap;
}

function renderFields() {
  const box = $('fields');
  box.innerHTML = '';
  for (const it of S.items) {
    if (it.deleted) continue;
    box.appendChild(it.type === 'raw' ? rawControl(it) : fieldControl(it));
  }
}

function presentKeys() {
  return new Set(S.items.filter(x => x.type === 'field' && !x.deleted).map(x => x.key));
}

function addItem(key, value = '') {
  const meta = fieldType(key);
  if (meta.type === 'object') {
    S.items.push({ type: 'raw', text: `${key}:` });
    return;
  }
  const kind = meta.type === 'array' ? 'array'
    : (meta.type === 'textarea' || key === 'description') ? 'block' : 'scalar';
  S.items.push({ type: 'field', key, kind, value });
}

function guessKind(key) {
  const t = guessType(key);
  return t === 'array' ? 'array' : (t === 'textarea' ? 'block' : 'scalar');
}

function guessDateKey() {
  const schema = schemaForCollection() || {};
  for (const k of Object.keys(schema)) if (schema[k].type === 'date') return k;
  for (const k of ['pubDate', 'date', 'publishDate', 'publishedDate', 'publish_date']) {
    if (S.hint.includes(k)) return k;
  }
  return 'pubDate';
}

/* ---------- модал: добавяне на поле ---------- */
function knownFields() {
  const map = new Map();
  const schema = schemaForCollection() || {};
  for (const [k, v] of Object.entries(schema)) {
    map.set(k, { key: k, type: v.type, optional: v.optional, values: v.values, src: 'схема' });
  }
  for (const k of S.hint) if (!map.has(k)) map.set(k, { key: k, type: guessType(k), optional: true, values: null, src: 'статии' });
  for (const k of COMMON_FIELDS) if (!map.has(k)) map.set(k, { key: k, type: guessType(k), optional: true, values: null, src: 'стандартно' });
  return [...map.values()];
}

function renderFieldList() {
  const box = $('fieldList');
  box.innerHTML = '';
  const q = $('fieldSearch').value.trim().toLowerCase();
  const have = presentKeys();
  const fields = knownFields()
    .filter(f => !q || f.key.toLowerCase().includes(q) || fieldLabel(f.key).toLowerCase().includes(q))
    .sort((a, b) => {
      const order = { 'схема': 0, 'статии': 1, 'стандартно': 2 };
      if (order[a.src] !== order[b.src]) return order[a.src] - order[b.src];
      return a.key.localeCompare(b.key, 'bg');
    });
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'fieldPick' + (have.has(f.key) ? ' present' : '');
    const info = document.createElement('div');
    info.className = 'fpInfo';
    const nm = document.createElement('div');
    nm.className = 'fpName';
    nm.textContent = fieldLabel(f.key);
    const sub = document.createElement('div');
    sub.className = 'fpSub';
    sub.textContent = `${f.key} · ${TYPE_NAMES[f.type] || f.type} · от ${f.src}`;
    info.append(nm, sub);
    const btn = document.createElement('button');
    if (have.has(f.key)) {
      btn.className = 'ghost small';
      btn.textContent = '✓ има го';
      btn.disabled = true;
    } else {
      btn.className = 'small';
      btn.textContent = 'Добави';
      btn.onclick = () => {
        addItem(f.key);
        renderFields();
        setDirty(true);
        renderFieldList();
      };
    }
    row.append(info, btn);
    box.appendChild(row);
  }
  if (!fields.length) box.innerHTML = '<div class="muted">Няма съвпадения.</div>';
}

function openFieldModal() {
  if (!S.file) { toast('Първо отвори или създай статия.'); return; }
  $('fieldSearch').value = '';
  $('fieldCustom').value = '';
  renderFieldList();
  $('modalField').hidden = false;
  $('fieldSearch').focus();
}

/* ---------- начални полета за нова статия ---------- */
function seedItems(title) {
  const items = [{ type: 'field', key: 'title', kind: 'quoted', value: title }];
  const schema = schemaForCollection() || {};
  const boolDefault = k => (k === 'published' ? 'true' : 'false');
  items.push({ type: 'field', key: guessDateKey(), kind: 'scalar', value: todayStr() });
  for (const k of [...Object.keys(schema), ...S.hint]) {
    if (items.some(x => x.key === k)) continue;
    const meta = schema[k] || { type: guessType(k) };
    if (meta.type === 'object') continue; // обектните полета се добавят като YAML от модала
    if (meta.type === 'boolean') items.push({ type: 'field', key: k, kind: 'scalar', value: boolDefault(k) });
    else if (meta.type === 'date') items.push({ type: 'field', key: k, kind: 'scalar', value: todayStr() });
    else if (meta.type === 'array') items.push({ type: 'field', key: k, kind: 'array', value: '' });
    else if (meta.type === 'select') items.push({ type: 'field', key: k, kind: 'scalar', value: (meta.values && meta.values[0]) || '' });
    else items.push({ type: 'field', key: k, kind: guessKind(k), value: '' });
  }
  if (!items.some(x => x.key === 'description')) {
    items.splice(1, 0, { type: 'field', key: 'description', kind: 'block', value: '' });
  }
  return items;
}

async function openEntry(file) {
  if (S.dirty && !confirm('Има незаписани промени. Напускате ли без запис?')) return;
  try {
    const d = await GET(`/api/entry?path=${encodeURIComponent(S.project.path)}&collection=${encodeURIComponent(S.collection)}&file=${encodeURIComponent(file)}`);
    S.file = d.file;
    S.items = d.items;
    S.body = d.body;
    S.hint = d.hint;
    setDirty(false);
    $('welcome').hidden = true;
    $('editor').hidden = false;
    $('saveBar').hidden = true;
    const titleItem = S.items.find(x => x.type === 'field' && x.key === 'title');
    $('entryTitle').textContent = titleItem && String(titleItem.value).trim() ? String(titleItem.value) : file;
    $('filePath').textContent = `${S.collection}/${d.file}`;
    $('bodyArea').value = S.body;
    updateWordCount();
    renderFields();
    $('preview').hidden = true;
    $('editorShell').hidden = false;
    $('toolbar').hidden = false;
    $('previewBtn').textContent = '👁 Преглед';
    renderHl();
    renderList();
  } catch (e) { toast(e.message); }
}

function currentAbsPath() {
  const c = S.collections.find(x => x.name === S.collection);
  return c ? `${S.project.path}/${c.dir}/${S.file}` : S.file;
}

/* ---------- запис / изтриване ---------- */
function showSaveBar(absPath) {
  $('saveBarPath').textContent = absPath || currentAbsPath();
  const u = ((S.project && S.project.devUrl) || '').trim();
  const a = $('viewOnSite');
  if (u) { a.href = u + '/'; a.style.display = ''; } else { a.style.display = 'none'; }
  $('saveBar').hidden = false;
}

async function saveEntry(overwriteOk = false) {
  if (!S.project || S.collection == null) return;
  const titleItem = S.items.find(x => x.type === 'field' && x.key === 'title' && !x.deleted);
  const title = titleItem ? String(titleItem.value) : '';
  let slug = S.file ? S.file.replace(/\.(md|mdx|markdown)$/i, '') : '';
  const cat = slug.includes('/') ? slug.slice(0, slug.lastIndexOf('/')) : '';
  slug = slug.split('/').pop();
  const payload = {
    path: S.project.path,
    collection: S.collection,
    file: S.file,
    category: cat,
    slug,
    items: S.items,
    body: $('bodyArea').value,
    overwriteOk,
  };
  try {
    const d = await POST('/api/save', payload);
    S.file = d.file;
    S.lastAbsPath = d.absPath || null;
    setDirty(false);
    $('entryTitle').textContent = titleItem && String(titleItem.value).trim() ? String(titleItem.value) : d.file;
    $('filePath').textContent = `${S.collection}/${d.file}`;
    await loadEntries();
    renderList();
    showSaveBar(d.absPath);
    toast('✓ Записано: ' + d.file);
  } catch (e) {
    if (e.message.includes('Вече съществува') && !overwriteOk) {
      if (confirm(e.message + '\n\nДа заменя ли съществуващия файл?')) return saveEntry(true);
      return;
    }
    toast('Грешка: ' + e.message);
  }
}

async function deleteEntry() {
  if (!S.file) return;
  if (!confirm(`Да изтрия ли „${S.file}“?\n(отива в .trash-local-admin в проекта — може да се възстанови)`)) return;
  try {
    const d = await POST('/api/delete', { path: S.project.path, collection: S.collection, file: S.file });
    S.file = null;
    S.items = [];
    S.body = '';
    setDirty(false);
    $('editor').hidden = true;
    $('welcome').hidden = false;
    await loadEntries();
    toast('Преместено в кош: ' + d.trash);
  } catch (e) { toast('Грешка: ' + e.message); }
}

/* ---------- нова статия ---------- */
function openNewModal() {
  if (!S.collection) { toast('Първо избери колекция.'); return; }
  $('newTitle').value = '';
  $('newSlug').value = '';
  S.slugTouched = false;
  const sel = $('newCategory');
  sel.innerHTML = '';
  const cats = [...new Set(S.entries.map(e => e.category).filter(Boolean))];
  const o0 = document.createElement('option');
  o0.value = '';
  o0.textContent = '— без категория (в основната папка) —';
  sel.appendChild(o0);
  for (const c of cats) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
  const oNew = document.createElement('option');
  oNew.value = '__new__';
  oNew.textContent = '＋ нова категория…';
  sel.appendChild(oNew);
  sel.onchange = () => {
    const isNew = sel.value === '__new__';
    $('newCategoryInput').hidden = !isNew;
    if (isNew) $('newCategoryInput').focus();
  };
  $('modalNew').hidden = false;
  $('newTitle').focus();
}

async function createEntry() {
  const title = $('newTitle').value.trim();
  if (!title) { toast('Напиши заглавие.'); return; }
  const cat = $('newCategory').value === '__new__'
    ? sanitizeSlug($('newCategoryInput').value) : $('newCategory').value;
  const slug = sanitizeSlug($('newSlug').value) || sanitizeSlug(title);
  if (!slug) { toast('Невалидно име на файл.'); return; }
  S.items = seedItems(title);
  S.body = '\n';
  const payload = {
    path: S.project.path,
    collection: S.collection,
    file: null,
    category: cat,
    slug,
    items: S.items,
    body: S.body,
    overwriteOk: false,
  };
  try {
    const d = await POST('/api/save', payload);
    $('modalNew').hidden = true;
    setDirty(false);
    await loadEntries();
    await openEntry(d.file);
    toast('✓ Създадено: ' + d.file);
  } catch (e) { toast('Грешка: ' + e.message); }
}

/* ---------- лента за форматиране ---------- */
function replaceSel(ta, text, selStart, selEnd) {
  ta.focus();
  let ok = false;
  try {
    ta.setSelectionRange(selStart, selEnd);
    ok = document.execCommand('insertText', false, text);
  } catch { ok = false; }
  if (!ok) {
    const v = ta.value;
    ta.value = v.slice(0, selStart) + text + v.slice(selEnd);
    const pos = selStart + text.length;
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function bodyRange() {
  const ta = $('bodyArea');
  const v = ta.value;
  const s = ta.selectionStart == null ? v.length : ta.selectionStart;
  const e = ta.selectionEnd == null ? s : ta.selectionEnd;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', Math.max(e, s));
  if (le === -1) le = v.length;
  return { ta, v, s, e, ls, le };
}

function wrapSel(before, after, placeholder) {
  const { ta, v, s, e } = bodyRange();
  const sel = v.slice(s, e);
  if (sel) {
    const already = v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after;
    if (already) replaceSel(ta, sel, s - before.length, e + after.length);
    else replaceSel(ta, before + sel + after, s, e);
  } else {
    const inner = placeholder || '';
    replaceSel(ta, before + inner + after, s, e);
    if (inner) ta.setSelectionRange(s + before.length, s + before.length + inner.length);
    else ta.setSelectionRange(s + before.length, s + before.length);
  }
  ta.focus();
}

function transformLines(fn) {
  const { ta, ls, le } = bodyRange();
  const lines = ta.value.slice(ls, le).split('\n');
  replaceSel(ta, fn(lines).join('\n'), ls, le);
}

function setHeading(level) {
  const pfx = '#'.repeat(level) + ' ';
  transformLines((lines) => {
    const all = lines.every(l => l.startsWith(pfx));
    return lines.map(l => {
      const stripped = l.replace(/^#{1,6}\s+/, '');
      return all ? stripped : pfx + stripped;
    });
  });
}

function togglePrefix(prefix) {
  transformLines((lines) => {
    const all = lines.every(l => l.startsWith(prefix) || l.trim() === '');
    return lines.map(l => (l.trim() === '' ? l : (all ? l.slice(prefix.length) : prefix + l)));
  });
}

function insertLink() {
  const { ta, v, s, e } = bodyRange();
  const sel = v.slice(s, e);
  const text = sel || 'текст';
  const md = `[${text}](url)`;
  replaceSel(ta, md, s, e);
  if (sel) ta.setSelectionRange(s + text.length + 3, s + text.length + 6);
  else ta.setSelectionRange(s + 1, s + 1 + text.length);
}

function insertTable() {
  const { ta, s } = bodyRange();
  const tpl = '\n| Колона 1 | Колона 2 |\n| --- | --- |\n| клетка | клетка |\n';
  replaceSel(ta, tpl, s, ta.selectionEnd);
}

function insertCodeBlock() {
  const { ta, v, s, e } = bodyRange();
  const sel = v.slice(s, e) || 'код';
  replaceSel(ta, `\n\`\`\`\n${sel}\n\`\`\`\n`, s, e);
}

function runCmd(cmd) {
  switch (cmd) {
    case 'h2': setHeading(2); break;
    case 'h3': setHeading(3); break;
    case 'bold': wrapSel('**', '**', 'текст'); break;
    case 'italic': wrapSel('*', '*', 'текст'); break;
    case 'strike': wrapSel('~~', '~~', 'текст'); break;
    case 'code': wrapSel('`', '`', 'код'); break;
    case 'codeblock': insertCodeBlock(); break;
    case 'ul': togglePrefix('- '); break;
    case 'ol': togglePrefix('1. '); break;
    case 'quote': togglePrefix('> '); break;
    case 'link': insertLink(); break;
    case 'image': openImgModal(null); break;
    case 'table': insertTable(); break;
    case 'hr': {
      const { ta, s, e } = bodyRange();
      replaceSel(ta, '\n\n---\n\n', s, e);
      break;
    }
    default: break;
  }
  setDirty(true);
  renderHl();
  if (!$('preview').hidden) renderPreview();
  updateWordCount();
}

/* ---------- снимки ---------- */
async function openImgModal(target) {
  if (!S.file) { toast('Първо отвори или създай статия.'); return; }
  S.imgTarget = target || null;
  $('imgModalTitle').textContent = target ? `Снимка за „${fieldLabel(target.item.key)}“` : 'Снимки';
  $('imgModalHint').innerHTML = target
    ? 'Кликни на снимка (или качи нова), за да я зададеш като стойност на полето — записва се пътят за сайта.'
    : 'Кликни на снимка, за да я вмъкнеш в текста на позицията на курсора. Адресът ѝ ще е пътят за сайта (напр. <code>/uploads/IMG-1234.jpg</code>).';
  $('modalImg').hidden = false;
  $('uploadStatus').textContent = '';
  await loadImages();
}

async function loadImages() {
  const grid = $('imgGrid');
  grid.innerHTML = '<div class="muted">Зареждане…</div>';
  try {
    const d = await GET(`/api/images?path=${encodeURIComponent(S.project.path)}`);
    grid.innerHTML = '';
    if (!d.images.length) {
      grid.innerHTML = '<div class="muted">Още няма качени снимки в „' + esc(d.mediaDir) + '“.</div>';
    }
    for (const im of d.images) {
      const cell = document.createElement('div');
      cell.className = 'imgCell';
      cell.title = im.sitePath + ' — клик за вмъкване';
      cell.onclick = () => insertImage(im);
      const img = document.createElement('img');
      img.src = im.url;
      img.loading = 'lazy';
      img.alt = im.name;
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = im.name;
      cell.appendChild(img);
      cell.appendChild(cap);
      grid.appendChild(cell);
    }
  } catch (e) { grid.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}

function insertImage(im) {
  $('modalImg').hidden = true;
  if (S.imgTarget && S.imgTarget.item) {
    const key = S.imgTarget.item.key;
    S.imgTarget.item.value = im.sitePath;
    S.imgTarget = null;
    renderFields();
    setDirty(true);
    toast(`${key} = ${im.sitePath}`);
    return;
  }
  S.imgTarget = null;
  const ta = $('bodyArea');
  const alt = im.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  const md = `![${alt}](${im.sitePath})`;
  const pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);
  const pad = before && !before.endsWith('\n') && pos === ta.value.length ? '\n' : '';
  ta.value = before + pad + md + (pos === ta.value.length ? '\n' : after);
  setDirty(true);
  updateWordCount();
  renderHl();
  toast('Вмъкната снимка: ' + im.sitePath);
  if (!$('preview').hidden) renderPreview();
}

async function uploadFiles(files) {
  const status = $('uploadStatus');
  let done = 0;
  for (const f of files) {
    status.textContent = `Качване… (${done + 1}/${files.length}) ${f.name}`;
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    try {
      const d = await POST('/api/upload', { path: S.project.path, filename: f.name, data });
      done++;
      insertImage({ ...d, name: d.name });
    } catch (e) {
      toast('Грешка при качване: ' + e.message);
      break;
    }
  }
  status.textContent = `Качени: ${done}`;
  if (S.imgTarget) { S.imgTarget = null; $('modalImg').hidden = true; }
  else await loadImages();
}

/* ---------- добавяне на проект ---------- */
async function openAddModal() {
  $('addPath').value = '';
  $('addRootsHint').textContent = S.config.roots.length
    ? 'Автоматично се търси в: ' + S.config.roots.join(' ; ') : '';
  $('modalAdd').hidden = false;
  $('addPath').focus();
}

async function addProject() {
  const p = $('addPath').value.trim();
  if (!p) return;
  try {
    const d = await POST('/api/projects/add', { path: p });
    $('modalAdd').hidden = true;
    await loadConfig();
    toast(`Добавен проект „${d.project.name}“ (${d.collections.length} колекции).`);
    await selectProject(d.project.path);
  } catch (e) { toast('Грешка: ' + e.message); }
}

/* ---------- брой думи ---------- */
function updateWordCount() {
  const t = $('bodyArea').value.trim();
  const n = t ? t.split(/\s+/).length : 0;
  const min = Math.max(1, Math.round(n / 180));
  $('wordCount').textContent = n ? `${n} думи · ~${min} мин четене` : '';
}

/* ---------- тема ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('la-theme', t); } catch { /* без localStorage */ }
  $('themeBtn').textContent = t === 'dark' ? '☀' : '🌙';
  $('themeBtn').title = t === 'dark' ? 'Превключи към светла тема' : 'Превключи към тъмна тема';
}

/* ---------- събития ---------- */
$('projectSelect').onchange = e => selectProject(e.target.value);
$('addProjectBtn').onclick = openAddModal;
$('scanBtn').onclick = async () => {
  try {
    const d = await POST('/api/projects/scan', {});
    await loadConfig();
    toast(`Намерени нови проекти: ${d.found}`);
  } catch (e) { toast(e.message); }
};
$('themeBtn').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
};
$('devUrlInput').onchange = async (e) => {
  updateOpenSite();
  if (S.project) await POST('/api/config', { project: S.project.path, devUrl: e.target.value });
};
$('searchBox').oninput = renderList;
$('newEntryBtn').onclick = openNewModal;
$('newCancel').onclick = () => { $('modalNew').hidden = true; };
$('newCreate').onclick = createEntry;
$('newTitle').oninput = () => {
  if (!S.slugTouched) $('newSlug').value = sanitizeSlug($('newTitle').value);
};
$('newSlug').oninput = () => { S.slugTouched = true; };
$('saveBtn').onclick = () => saveEntry();
$('deleteBtn').onclick = deleteEntry;
$('copyPathBtn').onclick = () => copyText(S.lastAbsPath || currentAbsPath());
$('previewBtn').onclick = () => {
  const p = $('preview');
  p.hidden = !p.hidden;
  $('editorShell').hidden = !p.hidden;
  $('toolbar').hidden = !p.hidden;
  $('previewBtn').textContent = p.hidden ? '👁 Преглед' : '✎ Редактиране';
  if (!p.hidden) { renderPreview(); p.scrollIntoView({ block: 'nearest' }); }
};
$('imgBtn').onclick = () => openImgModal(null);
$('imgClose').onclick = () => { $('modalImg').hidden = true; S.imgTarget = null; };
$('uploadBtn').onclick = () => $('uploadInput').click();
$('uploadInput').onchange = (e) => { if (e.target.files.length) uploadFiles([...e.target.files]); };
$('addFieldBtn').onclick = openFieldModal;
$('fieldSearch').oninput = renderFieldList;
$('fieldCancel').onclick = () => { $('modalField').hidden = true; };
$('fieldAddCustom').onclick = () => {
  const key = $('fieldCustom').value.trim();
  if (!key) return;
  addItem(key);
  $('modalField').hidden = true;
  renderFields();
  setDirty(true);
};
$('fieldCustom').onkeydown = (e) => { if (e.key === 'Enter') $('fieldAddCustom').onclick(); };
$('addCancel').onclick = () => { $('modalAdd').hidden = true; };
$('addOk').onclick = addProject;
$('addPath').onkeydown = e => { if (e.key === 'Enter') addProject(); };
$('bodyArea').oninput = () => { setDirty(true); updateWordCount(); renderHl(); if (!$('preview').hidden) renderPreview(); };
$('bodyArea').addEventListener('scroll', syncHl);
window.addEventListener('resize', syncHl);
document.querySelectorAll('#toolbar button[data-cmd]').forEach(b => {
  b.addEventListener('click', () => runCmd(b.dataset.cmd));
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEntry(); return; }
  if ((e.ctrlKey || e.metaKey) && e.target === $('bodyArea')) {
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); runCmd('bold'); }
    else if (k === 'i') { e.preventDefault(); runCmd('italic'); }
    else if (k === 'k') { e.preventDefault(); runCmd('link'); }
  }
});
window.addEventListener('beforeunload', (e) => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
});
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; });
});

/* ---------- старт ---------- */
(async () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  await loadConfig();
  showWelcome();
  if (S.config.lastProject) await selectProject(S.config.lastProject);
})();
