// Минимален frontmatter (YAML) парсер за локалния админ панел.
// Философия: разбира простите полета (низове, числа, дати, списъци, многоредов текст),
// а всичко по-сложно (вложени обекти, коментари) запазва ДОСЛОВНО, за да не се разваля.

export function splitFrontmatter(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return { fm: '', body: t, had: false };
  const start = t.indexOf('\n') + 1;
  let i = start;
  let end = -1;
  while (i <= t.length) {
    const nl = t.indexOf('\n', i);
    const line = nl === -1 ? t.slice(i) : t.slice(i, nl);
    if (/^---[ \t]*$/.test(line)) { end = i; break; }
    if (nl === -1) break;
    i = nl + 1;
  }
  if (end === -1) return { fm: '', body: t, had: false };
  const fm = t.slice(start, end);
  const body = t.slice(end).replace(/^---[ \t]*\n/, '');
  return { fm, body, had: true };
}

function splitQuotes(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

// Връща списък от елементи: {type:'field', key, kind, value} | {type:'raw', text}
// kind: scalar | quoted | array | block | empty
export function parseFm(fm) {
  const lines = String(fm).split('\n');
  const items = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    const m = line.match(/^([^:#\n]+):\s?(.*)$/);
    if (!m || /^\s/.test(line)) { items.push({ type: 'raw', text: line }); i++; continue; }
    const key = m[1].trim();
    const rest = m[2];
    const k = i + 1;

    // 1) Списък с тирета под ключа (само когато след ключа няма стойност)
    if (rest.trim() === '') {
      const arr = [];
      let j = k;
      while (j < lines.length && /^\s+- /.test(lines[j])) {
        arr.push(lines[j].replace(/^\s+-\s*/, '').trim());
        j++;
      }
      if (arr.length) {
        if (arr.some(a => /:/.test(a))) {
          // обектен списък → запазваме го дословно
          items.push({ type: 'raw', text: lines.slice(i, j).join('\n') });
          i = j; continue;
        }
        items.push({ type: 'field', key, kind: 'array', value: arr.join(', ') });
        i = j; continue;
      }
    }

    // 2) Многоредов текст: | или > (с незадължителен модификатор)
    if (/^[|>][+-]?\d*\s*$/.test(rest)) {
      const buf = [];
      let j = k;
      while (j < lines.length && (lines[j].startsWith(' ') || lines[j].trim() === '')) {
        buf.push(lines[j].replace(/^ {2}/, ''));
        j++;
      }
      while (buf.length && buf[buf.length - 1].trim() === '') buf.pop();
      items.push({ type: 'field', key, kind: 'block', value: buf.join('\n') });
      i = j; continue;
    }

    // 3) Вложена структура (отстъп) → запазваме дословно
    if (rest.trim() === '') {
      let p = k;
      while (p < lines.length && /^\s*$/.test(lines[p])) p++;
      if (p < lines.length && /^\s/.test(lines[p])) {
        const rawLines = [line];
        let q = k;
        while (q < lines.length && (/^\s*$/.test(lines[q]) || /^\s/.test(lines[q]))) { rawLines.push(lines[q]); q++; }
        while (rawLines.length && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
        items.push({ type: 'raw', text: rawLines.join('\n') });
        i = q; continue;
      }
      items.push({ type: 'field', key, kind: 'empty', value: '' });
      i = k; continue;
    }

    // 4) Списък в квадратни скоби: [a, b, c]
    const rt = rest.trim();
    if (rt.startsWith('[') && rt.endsWith(']')) {
      const parts = splitQuotes(rt.slice(1, -1));
      items.push({ type: 'field', key, kind: 'array', value: parts.map(p => p.trim().replace(/^['"]|['"]$/g, '')).join(', ') });
      i = k; continue;
    }

    // 5) Цитиран низ
    const qm = rt.match(/^(['"])([\s\S]*)\1$/);
    if (qm) {
      let val = qm[2];
      if (qm[1] === "'") val = val.replace(/''/g, "'");
      else val = val.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      items.push({ type: 'field', key, kind: 'quoted', value: val });
      i = k; continue;
    }

    // 6) Обикнова стойност (низ/число/дата/boolean)
    items.push({ type: 'field', key, kind: 'scalar', value: rt });
    i = k; continue;
  }
  return items;
}

function needQuote(v) {
  if (v === '') return true;
  if (/^\s|\s$/.test(v)) return true;
  if (/: /.test(v)) return true;
  if (/ #/.test(v)) return true;
  if (/^[#\-?*&!|>%@`"',\[\]{}]/.test(v)) return true;
  return false;
}

function escSingle(v) { return String(v).replace(/'/g, "''"); }

function fmtValue(it) {
  const v = it.value == null ? '' : String(it.value);
  switch (it.kind) {
    case 'array': {
      const parts = v.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) return '[]';
      return '[' + parts.map(p => (/[:,\[\]'"]/.test(p) ? `'${escSingle(p)}'` : p)).join(', ') + ']';
    }
    case 'block': {
      if (v === '') return "''";
      return '|-\n' + v.split('\n').map(l => (l === '' ? '' : '  ' + l)).join('\n');
    }
    case 'empty': return "''";
    case 'quoted': return `'${escSingle(v)}'`;
    default: {
      if (v === '') return "''";
      if (needQuote(v)) return `'${escSingle(v)}'`;
      return v;
    }
  }
}

export function serializeFm(items) {
  const out = [];
  for (const it of items) {
    if (it.type === 'raw') { out.push(it.text); continue; }
    if (it.deleted) continue;
    out.push(`${it.key}: ${fmtValue(it)}`);
  }
  return out.join('\n');
}

export function assembleEntry(fmText, body) {
  const b = String(body == null ? '' : body);
  return `---\n${fmText}\n---\n${b}`;
}

// Име на файл → чист слъг: пази кирилица/юникод, маха опасни знаци.
export function sanitizeSlug(name) {
  let s = String(name || '').trim();
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/[^\p{L}\p{N}\-.~]+/gu, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^[.\-]+/, '');
  s = s.replace(/[.\-]+$/, '');
  return s;
}

// Валиден ключ за frontmatter (позволява кирилица, латиница, цифри, тире, точка, долна черта)
export function isValidKey(key) {
  return typeof key === 'string'
    && /^[\p{L}\p{N}][\p{L}\p{N}_. \-]*$/u.test(key.trim())
    && key.length <= 80;
}
