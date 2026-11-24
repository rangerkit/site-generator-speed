// Site Generator Speed — a fast, dependency-free drop-in for makefun-site 1.0.0.
//
// run(input) returns, for one case's { site, templates, files }, exactly the
// output tree makefun-site 1.0.0's build returns: every page's index.html, the
// index and tag pages, build-report.txt and each static file, byte for byte.
//
// This is an independent reimplementation of the documented dialect (front
// matter, Markdown subset, template dialect, slug rule and report). It is
// written for speed: single-pass line scanners instead of per-line regexes,
// indexOf-driven inline rendering instead of per-character escaping, cached
// slug/date/link work inside each run, and array-join string building
// throughout. No state is kept between run() calls.

// ---------------------------------------------------------------- text rules

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ANY = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

function escapeHtml(s) {
  if (!ESC_ANY.test(s)) return s;
  return s.replace(ESC_ALL, (c) => ESC_MAP[c]);
}

const SLUG_MAX = 64;

/** The slug of `text`, computed exactly as the reference computes it. */
function slugifyCompute(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    // NFKD is the identity on ASCII and ASCII holds no combining marks.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep < 0) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateCompute(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s class). */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The number of words in `text`: runs of characters other than whitespace. */
function countWords(text) {
  let count = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c > 32) {
      // A word character, unless it is one of the Unicode spaces (all >= 0xa0).
      if (c >= 0xa0 && isWsCode(c)) { inWord = false; continue; }
      if (!inWord) { inWord = true; count++; }
    } else if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (!inWord) { inWord = true; count++; } // control characters are \S
  }
  return count;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function stripTrailingBlank(s) {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isLayoutName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** /^[a-z0-9]+(?:-[a-z0-9]+)*$/ */
function isSlugText(s) {
  if (s.length === 0) return false;
  let seg = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
    else if (c === 45) { if (seg === 0) return false; seg = 0; }
    else return false;
  }
  return seg > 0;
}

/** One front-matter key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isLayoutName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugText(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const n = text.length;
  let firstEnd = text.indexOf('\n');
  if (firstEnd === -1) firstEnd = n;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  if (firstEnd === n) return { error: 'the front matter is not closed' };
  // Collect the lines between the opening --- and the closing --- without
  // splitting the (much larger) body.
  const fmLines = [];
  let body = null;
  let p = firstEnd + 1;
  let lineNo = 2; // 1-based number of the line starting at p
  for (;;) {
    let e = text.indexOf('\n', p);
    if (e === -1) e = n;
    const line = text.slice(p, e);
    if (line === '---') {
      body = e === n ? '' : text.slice(e + 1);
      break;
    }
    fmLines.push(line, lineNo);
    if (e === n) return { error: 'the front matter is not closed' };
    p = e + 1;
    lineNo++;
  }
  const data = {};
  for (let k = 0; k < fmLines.length; k += 2) {
    const line = fmLines[k];
    const errNo = fmLines[k + 1];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${errNo} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = stripTrailingBlank(line.slice(j + 2));
    else return { error: `line ${errNo} is not "key: value"` };
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- markdown

/** A paragraph/quote/list line as rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  const n = line.length;
  let i = 3;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return line.slice(3, langEnd);
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= n) return null;
  const depth = i;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < n) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) break;
    i++;
  }
  let end = n;
  while (end > i) {
    const cc = line.charCodeAt(end - 1);
    if (cc !== 32 && cc !== 9) break;
    end--;
  }
  if (end === i) return null;
  return { depth, text: line.slice(i, end) };
}

/** A thematic break: --- or ***, then spaces or tabs only. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text (after "- " or "* "), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's { start, text } (after "N. "), or null. */
function orderedOf(line) {
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break (dispatched on the first character). */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  return false;
}

const ESCAPABLE_CHARS = '\\`*_[]()#+-.!>';

function isEscapable(ch) {
  return ESCAPABLE_CHARS.indexOf(ch) !== -1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const w = what.length;
  for (let j = from; j <= n - w; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < n && isEscapable(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isEscapable(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const WS_ANY = /\s/;
/** Finds the next character that can start an inline construct or needs escaping. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function renderInline(s, env) {
  const n = s.length;
  if (n === 0) return '';
  let out = '';
  let i = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) { out += s.slice(i); break; }
    if (m.index > i) { out += s.slice(i, m.index); i = m.index; }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && isEscapable(s[i + 1])) {
        const nx = s[i + 1];
        out += nx === '>' ? '&gt;' : nx;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += '<strong>' + renderInline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += '<em>' + renderInline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_ANY.test(target)) {
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + renderInline(s.slice(i + 1, k), env) + '</a>';
        i = mm + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    // One of & < > " ' — written escaped.
    out += ESC_MAP[c];
    i++;
  }
  return out;
}

/** A list block starting at line `i` (its first item already read): renders it, returns the next line index. */
function renderList(lines, i, ordered, start, firstItem, env, parts) {
  const n = lines.length;
  const items = [[trimLine(firstItem)]];
  i++;
  while (i < n) {
    const l = lines[i];
    let itemText = null;
    if (ordered) {
      const o = orderedOf(l);
      if (o !== null) itemText = o.text;
    } else itemText = bulletOf(l);
    if (itemText !== null) { items.push([trimLine(itemText)]); i++; }
    else if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; }
    else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
  let s = `${open}\n`;
  for (const item of items) s += `<li>${renderInline(item.join('\n'), env)}</li>\n`;
  parts.push(`${s}</${tag}>\n`);
  return i;
}

/**
 * `src` rendered in one pass over its lines: its HTML (a "\n" after every
 * block), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Block kinds are dispatched on
 * the line's first character, which decides every kind uniquely.
 */
function renderMarkdown(src, env, slugCached) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = '';
  let hasExcerpt = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        const bodyParts = [];
        while (i < n && !fenceClose(lines[i])) {
          bodyParts.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        parts.push(`<pre><code${cls}>${bodyParts.join('')}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugCached(h.text), ids);
        const html = renderInline(h.text, env);
        parts.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        i++;
        const t = trimLine(l);
        if (t !== '') q.push(t);
      }
      parts.push(q.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : `<blockquote>\n<p>${renderInline(q.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) { parts.push('<hr>\n'); i++; continue; }
      const b = bulletOf(line);
      if (b !== null) { i = renderList(lines, i, false, 1, b, env, parts); continue; }
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) { i = renderList(lines, i, true, o.start, o.text, env, parts); continue; }
    } else if ((c0 === 32 || c0 === 9) && isBlankLine(line)) { i++; continue; }
    const first = trimLine(line);
    i++;
    let html;
    if (i >= n || endsParagraph(lines[i])) {
      html = renderInline(first, env);
    } else {
      const body = [first, trimLine(lines[i])];
      i++;
      while (i < n && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
      html = renderInline(body.join('\n'), env);
    }
    if (!hasExcerpt) { excerpt = html; hasExcerpt = true; }
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt };
}

// --------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

class TplError extends Error {}

function tplFail(name, msg) {
  throw new TplError(`template "${name}": ${msg}`);
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

function isPathText(text) {
  const n = text.length;
  if (n === 0) return false;
  let segLen = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 46) {
      if (segLen === 0) return false;
      segLen = 0;
    } else if (isNameChar(c)) {
      if (segLen === 0 && !isNameStart(c)) return false;
      segLen++;
    } else return false;
  }
  return segLen > 0;
}

/** The path `text` names, split at its dots, or a TplError. */
function pathOf(name, text) {
  if (!isPathText(text)) tplFail(name, `${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isBlankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text (t 0), {{ }} (t 1), {{{ }}} (t 2) and {% %} (t 3). */
function tokenize(name, src) {
  const tokens = [];
  const n = src.length;
  let text = '';
  let i = 0;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) tplFail(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ t: 0, text }); text = ''; }
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) tplFail(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isBlankRange(src, lineStart, open) && isBlankRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 0, text }); text = ''; }
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/** /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/ on the trimmed tag, or null. */
function matchFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const path = tag.slice(i + 4);
  if (path === '' || WS_ANY.test(path)) return null;
  return { name: tag.slice(4, i), path };
}

/** /^if (not )?(\S+)$/ on the trimmed tag, or null. */
function matchIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) { not = true; rest = rest.slice(4); }
  if (rest === '' || WS_ANY.test(rest)) return null;
  return { not, path: rest };
}

/** /^include "([a-z0-9-]+)"$/ on the trimmed tag: the name, or null. */
function matchInclude(tag) {
  if (tag.length < 11 || !tag.startsWith('include "') || !tag.endsWith('"')) return null;
  const inner = tag.slice(9, -1);
  if (inner === '') return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

/** `src` parsed into its tree of nodes (a TplError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 1 || tok.t === 2) { body.push({ kind: tok.t === 1 ? 'var' : 'raw', path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    const forM = matchFor(tag);
    if (forM !== null) {
      const node = { kind: 'for', name: forM.name, path: pathOf(name, forM.path), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
      continue;
    }
    const ifM = matchIf(tag);
    if (ifM !== null) {
      const node = { kind: 'if', not: ifM.not, path: pathOf(name, ifM.path), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) tplFail(name, 'an else outside an if');
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) tplFail(name, `an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      continue;
    }
    const inc = matchInclude(tag);
    if (inc !== null) { body.push({ kind: 'include', name: inc }); continue; }
    tplFail(name, `{% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) tplFail(name, `a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = new Array(v.length);
    for (let i = 0; i < v.length; i++) parts[i] = textOf(v[i]);
    return parts.join(', ');
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, appended to `parts`. */
function renderInto(nodes, scope, ctx, depth, parts) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case 'text':
        parts.push(nd.text);
        break;
      case 'var':
        parts.push(escapeHtml(textOf(lookup(scope, nd.path))));
        break;
      case 'raw': {
        const t = textOf(lookup(scope, nd.path));
        if (t !== '') parts.push(t);
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[nd.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderInto(nd.body, { vars, parent: scope }, ctx, depth, parts);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, parts);
        break;
      }
    }
  }
}

function renderNodes(nodes, scope, ctx, depth) {
  const parts = [];
  renderInto(nodes, scope, ctx, depth, parts);
  return parts.join('');
}

// ------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const BROKEN = { broken: true };

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `t` opens with a URI scheme (^[A-Za-z][A-Za-z0-9+.-]*:). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** makefun-site 1.0.0's answer for one case's input: the output tree, path -> text. */
export function run(input) {
  // Per-call caches: slug, long-date and link work repeats heavily inside one
  // site (tag names, dates, link targets), and nothing may leak between cases.
  const slugCache = new Map();
  const slugCached = (t) => {
    let v = slugCache.get(t);
    if (v === undefined) { v = slugifyCompute(t); slugCache.set(t, v); }
    return v;
  };
  const dateCache = new Map();
  const longDateCached = (d) => {
    let v = dateCache.get(d);
    if (v === undefined) { v = longDateCompute(d); dateCache.set(d, v); }
    return v;
  };

  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplError) report.push(err.message);
      else throw err;
    }
  }

  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // 1. Sources in code-unit order of path; .md files are sources, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const allSources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      allSources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: refused sources and drafts are reported and dropped.
  const sources = [];
  for (const s of allSources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    sources.push(s);
  }

  // 3. Permalinks: the slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugCached(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const linkCache = new Map();
  const resolveLink = (target, dir, srcPath) => {
    if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35 || hasScheme(target)) return target;
    const key = `${dir}\n${target}`;
    let cached = linkCache.get(key);
    if (cached === undefined) {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      let res = BROKEN;
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) res = `${pg.url}${frag}`;
        else if (staticPaths.has(path)) res = `${base}/${path}${frag}`;
      }
      cached = res;
      linkCache.set(key, cached);
    }
    if (cached === BROKEN) {
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    }
    return cached;
  };
  for (const s of sources) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = { link: (target) => resolveLink(target, dir, srcPath) };
    const md = renderMarkdown(s.body, env, slugCached);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const arr = s.data.tags ?? [];
    for (let i = 0; i < arr.length; i++) {
      const sl = slugCached(arr[i]);
      if (!seen.has(sl)) { seen.add(sl); out.push(arr[i]); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugCached(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugCached(name);
      const t = bySlug.get(sl);
      return t !== undefined ? t : { name, slug: sl, url: '', posts: [] };
    });
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page, the index pages and the tag pages; then statics.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateCached(s.data.date),
  });
  const cardBase = (s) => {
    let b = s._card;
    if (b === undefined) {
      b = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDateCached(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      s._card = b;
    }
    return b;
  };
  const cardOf = (s) => Object.assign({}, cardBase(s));
  const pageOf = (s) => Object.assign({}, cardBase(s), {
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const v = { site, tags: allTags, recent };
    Object.assign(v, vars);
    return renderNodes(nodes, { vars: v, parent: null }, ctx, 0);
  };

  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every reported line and broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
