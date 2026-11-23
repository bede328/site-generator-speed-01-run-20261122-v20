// solve.js — site-generator v12 (hybrid: v11 frame + v4 markdown engine).
// Keeps v11's minimal frame (tiny file, no eval/new Function, templates as
// flat op arrays with pre-resolved binds + reusable loop frames, scalar
// closePos inline fix) and replaces the markdown engine with v4's proven
// technique: inline rendering jumps construct-to-construct via a native
// regex (SPECIAL_RE.exec, unaffected by --no-opt), plain paragraphs cost
// one search(), block classification works on ranges of the raw body
// string (no split('\n') + trim() per line), slugify is memoised.
// Root cause it fixes (measured in v11): v10/v11 markdown = O(chars) of
// interpreted JS; v4 markdown = O(constructs) of JS + native scan.
// Written fresh from the v11 study + v4's technique (our own code).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------- text ----------
function esc(s) {
  let o = '', j = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { o += s.slice(j, i) + '&amp;'; j = i + 1; }
    else if (c === 60) { o += s.slice(j, i) + '&lt;'; j = i + 1; }
    else if (c === 62) { o += s.slice(j, i) + '&gt;'; j = i + 1; }
    else if (c === 34) { o += s.slice(j, i) + '&quot;'; j = i + 1; }
    else if (c === 39) { o += s.slice(j, i) + '&#39;'; j = i + 1; }
  }
  return j === 0 ? s : o + s.slice(j);
}

const SLUG_MAX = 64;
const NONASCII = /[^\x00-\x7F]/;
// slugify's results, memoised: the function is pure, and tags/titles repeat
// across a build (same heading/tag text in ~250 files/case).
const slugCache = new Map();

function slugifyCached(text) {
  let s = slugCache.get(text);
  if (s === undefined) {
    s = slugify(text);
    slugCache.set(text, s);
  }
  return s;
}

function slugify(text) {
  // NFKD is the identity on ASCII and \p{M} matches nothing there, so an
  // ASCII-only text skips the normalize + mark-strip entirely. The loop then
  // walks UTF-16 units by char code instead of for-of code points: a
  // non-alphanumeric unit only sets the gap flag, so an astral character's
  // two surrogates behave exactly like the one for-of iteration did.
  const plain = NONASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

// Back-compat name used by the page loop: slugOf(title) == slugifyCached.
function slugOf(s) {
  return slugifyCached(s);
}

function dateLong(d) {
  return (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

function isBlank(ln) {
  for (let i = 0; i < ln.length; i++) {
    const c = ln.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trim(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function dropTrail(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(0, b);
}

// ---------- front matter ----------
function isKey(k) {
  if (!k.length) return false;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

// Returns the value on success (no wrapper object: ~7k calls/round),
// or { err } on failure (the only object it ever returns).
function checkVal(key, v) {
  if (key === 'title' || key === 'summary') {
    if (v.charCodeAt(0) === 34) { // quoted
      if (v.length < 2 || v.charCodeAt(v.length - 1) !== 34) return { err: 'a quoted string is not closed' };
      let o = '';
      for (let j = 1; j < v.length - 1; j++) {
        const c = v.charCodeAt(j);
        if (c === 92) {
          const d = v.charCodeAt(j + 1);
          if ((d !== 34 && d !== 92) || j + 1 === v.length - 1) return { err: 'a quoted string holds an escape other than \\" or \\\\' };
          o += v[j + 1];
          j++;
        } else if (c === 34) {
          return { err: 'a quoted string holds a stray quote' };
        } else o += v[j];
      }
      return o;
    }
    if (v.charCodeAt(0) === 91) return { err: 'a bare string opens on [' };
    return v;
  }
  if (key === 'date') {
    if (v.length === 10 && v.charCodeAt(4) === 45 && v.charCodeAt(7) === 45) {
      let ok = true;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = v.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      if (ok) {
        const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
        if (y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)) return v;
      }
    }
    return { err: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (v.length < 2 || v.charCodeAt(0) !== 91 || v.charCodeAt(v.length - 1) !== 93) return { err: 'not a list [a, b]' };
    const inner = v.slice(1, -1);
    if (trim(inner) === '') return [];
    const parts = inner.split(',');
    const out = [];
    for (let p of parts) {
      p = trim(p);
      if (p === '') return { err: 'an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        if (c === 34 || c === 91 || c === 93) return { err: 'an empty tag, or one holding " [ or ]' };
      }
      out.push(p);
    }
    return out;
  }
  if (key === 'draft') {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return { err: 'true or false' };
  }
  if (key === 'layout') {
    if (!v.length) return { err: 'not a template name' };
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { err: 'not a template name' };
    }
    return v;
  }
  if (key === 'slug') {
    if (!v.length || v.length > 64) return { err: 'not a slug' };
    let prevDash = false;
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 45) {
        if (i === 0 || i === v.length - 1 || prevDash) return { err: 'not a slug' };
        prevDash = true;
      } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
      else return { err: 'not a slug' };
    }
    return v;
  }
  return { err: 'unknown key "' + key + '"' };
}

const FM_KEYS = { title: 1, summary: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1 };

// Front matter over RANGES of the raw (normalised) source — no split('\n'),
// so no ~25k line strings per case. Returns { fm, bodyStart } where
// bodyStart is the CHAR OFFSET of the first body line (lines.slice(k)
// .join('\n') === src.slice(lineStart(k)) always, so the range-based
// renderer sees exactly the text the line-based one did).
function parseFMRange(src) {
  let p = 0, idx = 0, closeIdx = -1, bodyStart = -1;
  const fmRanges = [];
  while (true) {
    const e = src.indexOf('\n', p);
    const le = e === -1 ? src.length : e;
    if (idx === 0) {
      if (src.slice(p, le) !== '---') return { err: 'no front matter' };
    } else if (le - p === 3 && src.charCodeAt(p) === 45 && src.charCodeAt(p + 1) === 45 && src.charCodeAt(p + 2) === 45) {
      closeIdx = idx;
      bodyStart = e === -1 ? src.length : e + 1;
      break;
    } else {
      fmRanges.push([p, le, idx]);
    }
    if (e === -1) break;
    p = e + 1;
    idx++;
  }
  if (closeIdx === -1) return { err: 'the front matter is not closed' };
  const fm = {};
  for (const [a, b, li] of fmRanges) {
    const ln = src.slice(a, b);
    if (isBlank(ln)) continue;
    if (ln.charCodeAt(0) === 35) continue; // '#'
    const c = ln.indexOf(':');
    if (c < 1) return { err: 'line ' + (li + 1) + ' is not "key: value"' };
    const key = ln.slice(0, c);
    if (!isKey(key)) return { err: 'line ' + (li + 1) + ' is not "key: value"' };
    const rest = ln.slice(c + 1);
    if (rest === '') return { err: 'key "' + key + '" has no value' };
    if (rest.charCodeAt(0) !== 32) return { err: 'line ' + (li + 1) + ' is not "key: value"' };
    const v = dropTrail(rest.slice(1));
    if (!FM_KEYS[key]) return { err: 'unknown key "' + key + '"' };
    if (Object.hasOwn(fm, key)) return { err: 'key "' + key + '" is given twice' };
    if (v === '') return { err: 'key "' + key + '" has no value' };
    const r = checkVal(key, v);
    if (r !== null && typeof r === 'object' && r.err) return { err: 'key "' + key + '": ' + r.err };
    fm[key] = r;
  }
  if (!Object.hasOwn(fm, 'title')) return { err: 'no title' };
  return { fm, bodyStart };
}

// ---------- markdown (v4-style: ranges over the raw body string) ----------
// Characters that make inline rendering do anything at all.
const INLINE_SPECIAL = /[\\`*\[&<>"']/;
// Same set, /g, for jumping over plain runs (lastIndex set before every exec).
const SPECIAL_RE = /[\\`*\[&<>"']/g;
const WS_TARGET = /\s/;

// HTML-escape lookup by char code (only & < > " ' change).
const HTML_ESC = [];
HTML_ESC[38] = '&amp;';
HTML_ESC[60] = '&lt;';
HTML_ESC[62] = '&gt;';
HTML_ESC[34] = '&quot;';
HTML_ESC[39] = '&#39;';

// Backslash-escapable characters, by char code.
const ESCAPABLE_TABLE = new Uint8Array(128);
for (const c of '\\`*_[]()#+-.!>') ESCAPABLE_TABLE[c.charCodeAt(0)] = 1;

// JS \s by char code (for the ` {2,}\S` continuation check).
function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

// Whether the char at `j` is escaped: the backslashes immediately before
// it (from `from` on) pair up two by two, so an odd run escapes it.
function isEscaped(s, j, from) {
  let k = j - 1;
  let odd = false;
  while (k >= from && s.charCodeAt(k) === 92) {
    odd = !odd;
    k--;
  }
  return odd;
}

// The first index in [from, to) where `s` holds `what` whole outside a
// backslash escape, or -1.
function findUnescaped(s, what, from, to) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= to && isEscaped(s, j, from)) j = s.indexOf(what, j + 1);
  return j !== -1 && j + what.length <= to ? j : -1;
}

// The first single * in [from, to) (one whose run is not **), outside an
// escape, or -1.
function findSingleStar(s, from, to) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < to) {
    if (isEscaped(s, j, from)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

function resolveHref(t, cx) {
  const c0 = t.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return t; // '/' or '#'
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    let p = 1;
    while (p < t.length) {
      const c = t.charCodeAt(p);
      if (c === 58) return t; // scheme ':'
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { p++; continue; }
      break;
    }
  }
  let frag = '', path = t;
  const h = t.indexOf('#');
  if (h !== -1) { frag = t.slice(h); path = t.slice(0, h); }
  const parts = path.split('/');
  const stack = cx.dir ? cx.dir.split('/') : [];
  for (let q = 0; q < parts.length; q++) {
    const seg = parts[q];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length) stack.pop(); continue; }
    stack.push(seg);
  }
  const resolved = stack.join('/');
  const url = cx.pageMap.get(resolved);
  if (url !== undefined) return url + frag;
  if (cx.staticSet.has(resolved)) return cx.base + '/' + resolved + frag;
  cx.report.add('broken-link ' + cx.src + ' -> ' + t);
  return t;
}

// The range [a, b) of `s` rendered inline into `out`; `cx` carries the
// link resolver (resolveHref). Plain runs are jumped over with one regex
// exec (lastIndex is set before every exec, so the shared /g regex is
// safe across the recursive calls). Recursion passes ranges, never
// substrings, so no intermediate string is built for strong/emphasis/
// link text. This is the O(constructs) engine v4 proved: under --no-opt
// the regex still runs in the native engine, while a per-character JS
// loop pays interpreted cost on every character.
function inlineRange(s, a, b, cx, out) {
  SPECIAL_RE.lastIndex = a;
  let m = SPECIAL_RE.exec(s);
  if (m === null || m.index >= b) {
    if (a < b) out.push(s.slice(a, b));
    return;
  }
  // The match `m` is carried into the loop: the old shape re-exec'd at the
  // top of every iteration, so its first exec re-found the very match the
  // pre-loop exec had just found (one wasted native exec per inlineRange
  // call). The `first` flag skips that one exec; every later iteration
  // refreshes `m` from the new `i` (lastIndex is always set first, so the
  // shared /g regex stays safe across the recursive strong/em/link calls).
  let i = m.index;
  let plain = a;
  let first = true;
  while (i < b) {
    if (first) first = false;
    else {
      SPECIAL_RE.lastIndex = i;
      m = SPECIAL_RE.exec(s);
      if (m === null || m.index >= b) break;
      i = m.index;
    }
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // backslash: escapes one of \ ` * _ [ ] ( ) # + - . ! >
      if (j + 1 < b) {
        const d = s.charCodeAt(j + 1);
        if (d < 128 && ESCAPABLE_TABLE[d]) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push(d === 62 ? '&gt;' : s[j + 1]);
          i = j + 2;
          plain = i;
          continue;
        }
      }
      i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === 42) {
      if (j + 1 < b && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k !== -1 && k > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>');
          inlineRange(s, j + 2, k, cx, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k !== -1 && k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<em>');
        inlineRange(s, j + 1, k, cx, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', j + 1, b);
      const m2 = k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 || m2 >= b ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_TARGET.test(target)) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<a href="', esc(resolveHref(target, cx)), '">');
        inlineRange(s, j + 1, k, cx, out);
        out.push('</a>');
        i = m2 + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (j > plain) out.push(s.slice(plain, j));
    out.push(HTML_ESC[c]);
    i = j + 1;
    plain = i;
  }
  if (plain < b) out.push(s.slice(plain, b));
}

// Shared scratch output array for inline(). Safe: inline() is never active
// while another inline() is active (inlineRange recurses through itself,
// not through inline()); length is reset before every use.
const SCRATCH_OUT = [];

// `s` rendered inline. One search() finds the first special and proves
// none exist; the loop then starts there. A text with no special at all
// returns untouched — the fast path that makes plain paragraphs ~free.
function inline(s, cx) {
  const first = s.search(INLINE_SPECIAL);
  if (first === -1) return s;
  const out = SCRATCH_OUT;
  out.length = 0;
  inlineRange(s, 0, s.length, cx, out);
  return out.join('');
}

// The end of the line starting at `pos` (exclusive, without the '\n').
function lineEnd(s, pos) {
  const nl = s.indexOf('\n', pos);
  return nl === -1 ? s.length : nl;
}

// Whether the range [a, b) is empty or only spaces/tabs.
function isBlankRange(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A fence-open line's language, or null. `^```([A-Za-z0-9_+-]*)[ \t]*$`
function fenceOpen(s, a, b) {
  if (a + 2 >= b || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(a + 3, i);
  while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i === b ? lang : null;
}

// Whether the range [a, b) closes a fence: `^```[ \t]*$`.
function fenceClose(s, a, b) {
  if (a + 2 >= b || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  let i = a + 3;
  while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i === b;
}

// A heading line's level and trimmed text range, or null (a heading's text is never empty).
function headingOf(s, a, b) {
  let hashes = 0;
  while (a + hashes < b && s.charCodeAt(a + hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  let i = a + hashes;
  if (i >= b || (s.charCodeAt(i) !== 32 && s.charCodeAt(i) !== 9)) return null;
  while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  let end = b;
  while (end > i && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth: hashes, ta: i, tb: end };
}

// Whether the range [a, b) is a thematic break.
function isHR(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(a + 1) !== c0 || s.charCodeAt(a + 2) !== c0) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A bullet-list line's item text start, or -1. `^[-*] (.*)$`
function bulletOf(s, a, b) {
  const c = s.charCodeAt(a);
  if ((c === 45 || c === 42) && a + 1 < b && s.charCodeAt(a + 1) === 32) return a + 2;
  return -1;
}

// An ordered-list line's [start, textStart], or null. `^(\d{1,9})\. (.*)$`
function orderedOf(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
  if (i === a || i - a > 9) return null;
  if (i + 1 >= b || s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== 32) return null;
  return [Number(s.slice(a, i)), i + 2];
}

// A line range with spaces and tabs at either end dropped, as [ta, tb).
function trimRange(s, a, b) {
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return [a, b];
}

// Whether the range [a, b) ends a paragraph: a blank line, a fence, a heading or a thematic break.
function endsParagraph(s, a, b) {
  if (a === b) return true;
  const c0 = s.charCodeAt(a);
  if (c0 === 32 || c0 === 9) return isBlankRange(s, a, b);
  if (c0 === 96) return fenceOpen(s, a, b) !== null;
  if (c0 === 35) return headingOf(s, a, b) !== null;
  if (c0 === 45 || c0 === 42) return isHR(s, a, b);
  return false;
}

// Whether the range [a, b) continues a list item: /^ {2,}\S/.
function isContinued(s, a, b) {
  let k = a;
  while (k < b && s.charCodeAt(k) === 32) k++;
  return k - a >= 2 && k < b && !isWSCode(s.charCodeAt(k));
}

// Whitespace (JS \s) by char code, for wordsOf.
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;

// The words of a range [a, b): its runs of characters other than
// whitespace (JS \s, no allocation).
function wordsOfRange(text, a, b) {
  let count = 0;
  let inWord = false;
  for (let i = a; i < b; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// `src` rendered from char offset `start`: its HTML (each block on its
// own lines, a "\n" after the last), its table of contents (every level 2
// and 3 heading: level, id and its inline HTML) and its excerpt (the
// first paragraph's inline HTML, or ""). Lines are ranges of the raw
// source: classifying a line never allocates it.
function renderMdStr(src, start, cx) {
  const n = src.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let p = start;
  while (p < n) {
    const a = p;
    const b = lineEnd(src, p);
    const nx = b === n ? n : b + 1;
    const c0 = a < b ? src.charCodeAt(a) : -1;
    // Dispatch on the first character: a block can only start as a fence
    // ('`'), heading ('#'), thematic break or bullet ('-'/'*'), blockquote
    // ('>'), ordered list (digit), blank ('' or space/tab) or paragraph.
    if (a === b || c0 === 32 || c0 === 9) {
      if (a === b || isBlankRange(src, a, b)) {
        p = nx;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(src, a, b);
      if (lang !== null) {
        p = nx;
        const code = ['<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>'];
        let closed = false;
        while (p < n) {
          const ba = p;
          const bb = lineEnd(src, p);
          if (fenceClose(src, ba, bb)) {
            p = bb === n ? n : bb + 1;
            closed = true;
            break;
          }
          code.push(esc(src.slice(ba, bb)), '\n');
          p = bb === n ? n : bb + 1;
        }
        // An unclosed fence whose source ends with '\n' takes one more empty
        // body line: split('\n') yields a trailing "" element for it, and the
        // reference pushes that line into the fence body too.
        if (!closed && n > 0 && src.charCodeAt(n - 1) === 10) code.push('\n');
        blocks.push(code.join('') + '</code></pre>');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(src, a, b);
      if (heading !== null) {
        const text = src.slice(heading.ta, heading.tb);
        const id = uniqueSlug(slugifyCached(text), ids);
        const html = inline(text, cx);
        blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        p = nx;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(src, a, b)) {
        blocks.push('<hr>');
        p = nx;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      let q = a;
      while (q < n) {
        const qb = lineEnd(src, q);
        if (qb === q || src.charCodeAt(q) !== 62) break;
        let s = q + 1;
        if (s < qb && src.charCodeAt(s) === 32) s++;
        const [ta, tb] = trimRange(src, s, qb);
        if (ta < tb) body.push(src.slice(ta, tb));
        q = qb === n ? n : qb + 1;
      }
      p = q;
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(body.join('\n'), cx) + '</p>\n</blockquote>');
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? bulletOf(src, a, b) : -1;
    const ordered = bullet === -1 && c0 >= 48 && c0 <= 57 ? orderedOf(src, a, b) : null;
    if (bullet !== -1 || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      // The loop starts on the current line itself (as the reference does):
      // its first iteration pushes the opening item.
      while (p < n) {
        const la = p;
        const lb = lineEnd(src, p);
        const lnx = lb === n ? n : lb + 1;
        let m = false;
        let textStart = -1;
        if (isOrdered) {
          const o = orderedOf(src, la, lb);
          if (o !== null) {
            m = true;
            textStart = o[1];
          }
        } else {
          textStart = bulletOf(src, la, lb);
          if (textStart !== -1) m = true;
        }
        if (m) {
          const [ta, tb] = trimRange(src, textStart, lb);
          items.push([src.slice(ta, tb)]);
          p = lnx;
        } else if (isContinued(src, la, lb)) {
          const [ta, tb] = trimRange(src, la, lb);
          items[items.length - 1].push(src.slice(ta, tb));
          p = lnx;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? ordered[0] : 1;
      const open = isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let list = open + '\n';
      for (const parts of items) list += '<li>' + inline(parts.join('\n'), cx) + '</li>\n';
      blocks.push(list + '</' + tag + '>');
      continue;
    }
    const [ta0, tb0] = trimRange(src, a, b);
    const body = [src.slice(ta0, tb0)];
    p = nx;
    while (p < n) {
      const la = p;
      const lb = lineEnd(src, p);
      if (endsParagraph(src, la, lb)) break;
      const [ta, tb] = trimRange(src, la, lb);
      body.push(src.slice(ta, tb));
      p = lb === n ? n : lb + 1;
    }
    const html = inline(body.join('\n'), cx);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------- templates ----------
// ops: [0, text] TEXT | [1, bind] ESC | [2, bind] RAW
//      [3, depth, varName, bind, endIdx] FOR | [4] ENDFOR
//      [5, bind, neg, elseIdx, endIdx] IF | [6, endIdx] ELSE
//      [7] ENDIF | [8, name] INCLUDE
// A bind pre-resolves a path at parse time against the lexical for-stack:
//   [0, root, rest] — top-level ctx key (dynamic shadow check at render
//     still lets an enclosing loop var / loop object win, exactly like
//     the old scope-chain walk, so {% include %} inside a loop keeps
//     working);
//   [1, depth, rest] — the `loop` object of the for at lexical depth;
//   [2, depth, rest] — the loop variable of the for at lexical depth.
// Rest segments are still walked with Object.hasOwn, so prototype names
// ('toString', 'constructor') never resolve.
function parsePath(str) {
  const s = str.trim();
  if (s === '') return null;
  const parts = s.split('.');
  for (const p of parts) {
    if (!p.length) return null;
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (i === 0) {
        if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return null;
      } else if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return null;
    }
  }
  return parts;
}

function parseTpl(src) {
  // A {% %} tag ALONE on a line consumes the whole line: the tag still
  // executes, but the line's surrounding whitespace and its \n emit nothing.
  const lines = src.split('\n');
  let s = '';
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const isLast = li === lines.length - 1;
    let tagOnly = null;
    const a = ln.indexOf('{%');
    if (a !== -1 && ln.indexOf('{%', a + 2) === -1) {
      const b = ln.indexOf('%}', a + 2);
      if (b !== -1 && ln.indexOf('%}', b + 2) === -1) {
        let ok = true;
        for (let k = 0; k < a; k++) {
          const c = ln.charCodeAt(k);
          if (c !== 32 && c !== 9) { ok = false; break; }
        }
        if (ok) for (let k = b + 2; k < ln.length; k++) {
          const c = ln.charCodeAt(k);
          if (c !== 32 && c !== 9) { ok = false; break; }
        }
        if (ok) tagOnly = ln.slice(a, b + 2);
      }
    }
    if (tagOnly !== null) s += tagOnly;
    else { s += ln; if (!isLast) s += '\n'; }
  }
  const ops = [];
  const stack = [];
  const forStack = []; // loop var names, innermost last
  function bindPath(ptxt) {
    const p = parsePath(ptxt);
    if (!p) return null;
    const r0 = p[0];
    if (r0 === 'loop' && forStack.length) return [1, forStack.length - 1, p.slice(1)];
    for (let d = forStack.length - 1; d >= 0; d--) {
      if (forStack[d] === r0) return [2, d, p.slice(1)];
    }
    return [0, r0, p.slice(1)];
  }
  let i = 0, j = 0;
  const n = s.length;
  while (i < n) {
    let k = -1;
    const k1 = s.indexOf('{{{', i), k2 = s.indexOf('{{', i), k3 = s.indexOf('{%', i);
    if (k1 !== -1) k = k1;
    if (k2 !== -1 && (k === -1 || k2 < k)) k = k2;
    if (k3 !== -1 && (k === -1 || k3 < k)) k = k3;
    if (k === -1) break;
    if (k > j) {
      const t = s.slice(j, k);
      const last = ops[ops.length - 1];
      if (last && last[0] === 0) last[1] += t;
      else ops.push([0, t]);
    }
    if (s.charCodeAt(k + 2) === 123) { // '{{{' raw
      const e = s.indexOf('}}}', k + 3);
      if (e === -1) return { err: 'a {{{ is not closed' };
      const ptxt = s.slice(k + 3, e).trim();
      const b = bindPath(ptxt);
      if (!b) return { err: '"' + ptxt + '" is not a path' };
      ops.push([2, b]);
      i = e + 3; j = i;
    } else if (s.charCodeAt(k + 1) === 123) { // '{{' esc
      const e = s.indexOf('}}', k + 2);
      if (e === -1) return { err: 'a {{ is not closed' };
      const ptxt = s.slice(k + 2, e).trim();
      const b = bindPath(ptxt);
      if (!b) return { err: '"' + ptxt + '" is not a path' };
      ops.push([1, b]);
      i = e + 2; j = i;
    } else { // '{%' tag
      const e = s.indexOf('%}', k + 2);
      if (e === -1) {
        const inner = s.slice(k + 2).trim();
        let w = inner, sp = -1;
        for (let q = 0; q < inner.length; q++) {
          const c = inner.charCodeAt(q);
          if (c === 32 || c === 9 || c === 10) { sp = q; break; }
        }
        if (sp !== -1) w = inner.slice(0, sp);
        if (w === 'if' || w === 'for') return { err: 'a ' + w + ' is not closed' };
        return { err: 'a {% is not closed' };
      }
      const tag = s.slice(k + 2, e).trim();
      const tagErr = '{% ' + tag + ' %} is not a tag';
      if (tag.startsWith('for ')) {
        const rest = tag.slice(4);
        const sp = rest.indexOf(' in ');
        if (sp < 1) return { err: tagErr };
        const vn = rest.slice(0, sp);
        if (!isName(vn)) return { err: tagErr };
        const ptxt = rest.slice(sp + 4).trim();
        if (ptxt === '' || ptxt.indexOf(' ') !== -1 || ptxt.indexOf('\t') !== -1) return { err: tagErr };
        const b = bindPath(ptxt);
        if (!b) return { err: '"' + ptxt + '" is not a path' };
        const depth = forStack.length;
        stack.push({ kind: 3, idx: ops.length });
        forStack.push(vn);
        ops.push([3, depth, vn, b, -1]);
      } else if (tag === 'endfor') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 3) return { err: 'an endfor with no open for' };
        stack.pop();
        forStack.pop();
        ops[top.idx][4] = ops.length;
        ops.push([4]);
      } else if (tag.startsWith('if ')) {
        let rest = tag.slice(3), neg = 0;
        if (rest.startsWith('not ')) { neg = 1; rest = rest.slice(4); }
        const ptxt = rest.trim();
        if (ptxt === '' || ptxt.indexOf(' ') !== -1 || ptxt.indexOf('\t') !== -1) return { err: tagErr };
        const b = bindPath(ptxt);
        if (!b) return { err: '"' + ptxt + '" is not a path' };
        stack.push({ kind: 5, idx: ops.length, elseIdx: -1 });
        ops.push([5, b, neg, -1, -1]);
      } else if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 5 || top.elseIdx !== -1) return { err: 'an else outside an if' };
        top.elseIdx = ops.length;
        ops[top.idx][3] = ops.length;
        ops.push([6, -1]);
      } else if (tag === 'endif') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 5) return { err: 'an endif with no open if' };
        stack.pop();
        ops[top.idx][4] = ops.length;
        if (top.elseIdx !== -1) ops[top.elseIdx][1] = ops.length;
        ops.push([7]);
      } else if (tag.startsWith('include ')) {
        const rest = tag.slice(8).trim();
        if (rest.length < 2 || rest.charCodeAt(0) !== 34 || rest.charCodeAt(rest.length - 1) !== 34) return { err: tagErr };
        const name = rest.slice(1, -1);
        if (name === '' || name.indexOf('"') !== -1) return { err: tagErr };
        ops.push([8, name]);
      } else {
        return { err: tagErr };
      }
      i = e + 2; j = i;
    }
  }
  if (n > j) {
    const t = s.slice(j, n);
    const last = ops[ops.length - 1];
    if (last && last[0] === 0) last[1] += t;
    else ops.push([0, t]);
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return { err: top.kind === 3 ? 'a for is not closed' : 'a if is not closed' };
  }
  return { ops };
}

function isName(vn) {
  if (!vn.length) return false;
  for (let i = 0; i < vn.length; i++) {
    const c = vn.charCodeAt(i);
    if (i === 0) {
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return false;
    } else if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
}

// Resolve a pre-resolved bind. `frames` holds one reusable frame object
// per active for level ({name, item, loop}); `base` is the frame offset
// of this template invocation (0 at top level, cx.top at {% include %});
// cx.top counts the currently active frames, so a ctx bind can still
// see a dynamically enclosing loop var (include inside a loop).
function resolveBind(b, frames, base, cx) {
  let v;
  const rest = b[2];
  if (b[0] === 1) { // loop object of the for at lexical depth b[1]
    v = frames[base + b[1]].loop;
  } else if (b[0] === 2) { // loop variable at lexical depth b[1]
    v = frames[base + b[1]].item;
  } else { // top-level ctx key, with dynamic shadow check
    const root = b[1];
    if (root === 'loop') {
      if (cx.top > 0) v = frames[cx.top - 1].loop;
      else if (Object.hasOwn(cx.ctx, root)) v = cx.ctx[root];
      else return undefined;
    } else {
      let found = false;
      for (let f = cx.top - 1; f >= 0; f--) {
        if (frames[f].name === root) { v = frames[f].item; found = true; break; }
      }
      if (!found) {
        if (!Object.hasOwn(cx.ctx, root)) return undefined;
        v = cx.ctx[root];
      }
    }
  }
  for (let i = 0; i < rest.length; i++) {
    const nm = rest[i];
    if (v !== null && (typeof v === 'object' || typeof v === 'function') && Object.hasOwn(v, nm)) v = v[nm];
    else return undefined;
  }
  return v;
}

function truthy(v) {
  return !(v === undefined || v === null || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0));
}

function writeVal(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) { if (i) s += ', '; s += writeVal(v[i]); }
    return s;
  }
  return '';
}

function renderOps(ops, lo, hi, frames, base, cx, depth, out) {
  for (let p = lo; p < hi; p++) {
    const op = ops[p];
    const k = op[0];
    switch (k) {
    case 0: out.push(op[1]); break;
    case 1: out.push(esc(writeVal(resolveBind(op[1], frames, base, cx)))); break;
    case 2: out.push(writeVal(resolveBind(op[1], frames, base, cx))); break;
    case 3: {
      const arr = resolveBind(op[3], frames, base, cx);
      out.push(forStr(ops, p, op, arr, frames, base, cx, depth));
      p = op[4];
      break;
    }
    case 5: {
      let t = truthy(resolveBind(op[1], frames, base, cx));
      if (op[2]) t = !t;
      if (t) renderOps(ops, p + 1, op[3] >= 0 ? op[3] : op[4], frames, base, cx, depth, out);
      else if (op[3] >= 0) renderOps(ops, op[3] + 1, op[4], frames, base, cx, depth, out);
      p = op[4];
      break;
    }
    case 8:
      if (depth < 8) {
        const t = cx.templates[op[1]];
        if (t) renderOps(t, 0, t.length, frames, cx.top, cx, depth + 1, out);
      }
      break;
    // ENDFOR/ELSE/ENDIF: never executed (ranges and jumps skip them)
    }
  }
}
// One top-level render: fresh accumulator, joined once. (Nested includes and
// if-branches push straight into the caller's accumulator — no array + join
// per include/if any more; for-ops still return a string via forStr so the
// memoize cache keeps working.)
function renderStr(ops, frames, base, cx) { const a = []; renderOps(ops, 0, ops.length, frames, base, cx, 0, a); return a.join(''); }

// ---------- for-loop memoization ----------
// A for-op's rendered string is a pure function of (ops, op index, array)
// ONLY if every bind its body can reach resolves to the loop var, the loop
// object, or a run-constant ctx value (site/tags/recent). Anything else
// (page/posts/pager/tag, or an enclosing loop's var) varies per render and
// must NOT be memoized: a stale cache = wrong answers = $0.
// okB: kind-0 binds must name a run-constant; kind-1/2 binds must refer to
// this for (depth d) or a for nested inside it (depth > d), never an
// enclosing for (depth < d). Inside an included template (d = -1) kind-1/2
// binds refer to that template's own fors and are always in-unit.
// pureOps walks the body linearly (if-branches are inline) and follows
// includes (depth guard mirrors renderOps' depth < 8).
function okB(b, d) {
  if (b[0] === 0) { const r = b[1]; return r === 'loop' || r === 'site' || r === 'tags' || r === 'recent'; }
  return d < 0 || b[1] >= d;
}
function pureOps(ops, lo, hi, d, t, dep) {
  for (let i = lo; i < hi; i++) {
    const o = ops[i], k = o[0];
    if (k === 1 || k === 2 || k === 5) { if (!okB(o[1], d)) return false; }
    else if (k === 3) {
      if (!okB(o[3], d)) return false;
      if (!pureOps(ops, i + 1, o[4], d, t, dep)) return false;
      i = o[4];
    } else if (k === 8) {
      if (dep > 8) return false;
      const u = t[o[1]];
      if (u && !pureOps(u, 0, u.length, -1, t, dep + 1)) return false;
    }
  }
  return true;
}
// Render one for-op, memoizing only when pureOps proves it pure. The
// per-ops cache hangs off the ops array itself (ops._m): the ops arrays are
// parsed fresh per run, so the cache is per-run by construction, and one
// property read replaces a Map.get. Keyed (op index -> array identity):
// the same array rendered by a DIFFERENT for-op (e.g. `tags` in the tags
// index vs in a badge snippet) must NOT share an entry.
function forStr(ops, p, op, arr, frames, base, cx, depth) {
  if (!Array.isArray(arr)) return '';
  let byOps = ops._m;
  if (!byOps) { byOps = new Map(); ops._m = byOps; }
  let ent = byOps.get(p);
  if (!ent) {
    ent = { ok: cx.memoOk && pureOps(ops, p + 1, op[4], op[1], cx.templates, 0), byArr: new Map() };
    byOps.set(p, ent);
  }
  if (ent.ok) {
    const hit = ent.byArr.get(arr);
    if (hit !== undefined) return hit;
  }
  const fi = base + op[1];
  let fr = frames[fi];
  if (!fr) { fr = { name: '', item: undefined, loop: { index: 0, first: false, last: false, length: 0 } }; frames[fi] = fr; }
  fr.name = op[2];
  const lp = fr.loop, nn = arr.length, savedTop = cx.top;
  cx.top = fi + 1;
  const parts = [];
  for (let q = 0; q < nn; q++) {
    fr.item = arr[q];
    lp.index = q + 1; lp.first = q === 0; lp.last = q === nn - 1; lp.length = nn;
    renderOps(ops, p + 1, op[4], frames, base, cx, depth, parts);
  }
  cx.top = savedTop;
  const s = parts.join('');
  if (ent.ok) ent.byArr.set(arr, s);
  return s;
}

// ---------- byte-level markdown (v20) ----------
// Input arrives as JS strings (JSON.parse already decoded); output must be
// strings (JSON.stringify). The byte engine pays TextEncoder/TextDecoder
// round-trip (~9 ms, ceiling-measured) and wins by removing allocations:
// no slice() per construct, no cons-string chains, bulk arena.set (native
// memcpy) for plain runs, word counting fused into the single pass.
// UTF-8 safety: ASCII specials are single bytes < 0x80; multi-byte
// sequences never contain a byte < 0x80, so byte scanning for ASCII
// specials is exact. Closer searches use Uint8Array.indexOf (native).
// NEVER indexOf-per-segment for the main scan (Jalur-1 #2): the main scan
// is one per-byte loop; indexOf is used only for closer searches, exactly
// where v14 uses String.indexOf.
// Word counting is fused: every body byte contributes to wcWords/wcInWord
// exactly once — inline loop (top-level + recursive, shared state),
// fence/code-span esc loops, and +1 per block marker in the dispatch.
// Markers are word runs because a line starts after '\n' (inWord false);
// the space/newline after a marker resets inWord before the text.

const encB = new TextEncoder();
const decB = new TextDecoder();
let inArena = new Uint8Array(1 << 20);
let outArena = new Uint8Array(1 << 20);
let scratchB = new Uint8Array(1 << 16);
let outLen = 0;
let wcWords = 0;
let wcInWord = false;
let scratchLenCur = 0;

// T256[c]: bit0 = inline-special (v14 SPECIAL_RE set, EXACT — no ']'),
// bit1 = ASCII whitespace.
const T256 = new Uint8Array(256);
for (const cc of [92, 96, 42, 91, 38, 60, 62, 34, 39]) T256[cc] |= 1;
for (const cc of [32, 9, 10, 11, 12, 13]) T256[cc] |= 2;
// esc chars only (& < > " ').
const ESC_T = new Uint8Array(256);
for (const cc of [38, 60, 62, 34, 39]) ESC_T[cc] = 1;

const B_AMP = encB.encode('&amp;');
const B_LT = encB.encode('&lt;');
const B_GT = encB.encode('&gt;');
const B_QUOT = encB.encode('&quot;');
const B_APOS = encB.encode('&#39;');
const ENT_BY_CODE = [];
ENT_BY_CODE[38] = B_AMP; ENT_BY_CODE[60] = B_LT; ENT_BY_CODE[62] = B_GT;
ENT_BY_CODE[34] = B_QUOT; ENT_BY_CODE[39] = B_APOS;
const B_P_OPEN = encB.encode('<p>');
const B_P_CLOSE = encB.encode('</p>');
const B_STRONG_OPEN = encB.encode('<strong>');
const B_STRONG_CLOSE = encB.encode('</strong>');
const B_EM_OPEN = encB.encode('<em>');
const B_EM_CLOSE = encB.encode('</em>');
const B_CODE_OPEN = encB.encode('<code>');
const B_CODE_CLOSE = encB.encode('</code>');
const B_A_OPEN = encB.encode('<a href="');
const B_A_MID = encB.encode('">');
const B_A_CLOSE = encB.encode('</a>');
const B_HR = encB.encode('<hr>');
const B_BQ_OPEN = encB.encode('<blockquote>\n<p>');
const B_BQ_CLOSE = encB.encode('</p>\n</blockquote>');
const B_BQ_EMPTY = encB.encode('<blockquote>\n</blockquote>');
const B_PRE_CODE = encB.encode('<pre><code');
const B_PRE_CODE_CLOSE = encB.encode('</code></pre>');
const B_CLASS_LANG = encB.encode(' class="language-');
const B_LI_OPEN = encB.encode('<li>');
const B_LI_CLOSE = encB.encode('</li>\n');
const B_UL_OPEN = encB.encode('<ul>');
const B_UL_CLOSE = encB.encode('</ul>');
const B_OL_OPEN = encB.encode('<ol>');
const B_OL_CLOSE = encB.encode('</ol>');

function oEnsure(n) {
  if (outLen + n > outArena.length) {
    const nb = new Uint8Array(Math.max(outLen + n, outArena.length * 2));
    nb.set(outArena.subarray(0, outLen));
    outArena = nb;
  }
}
function oSet(u, a, b) {
  if (b <= a) return;
  oEnsure(b - a);
  outArena.set(u.subarray(a, b), outLen);
  outLen += b - a;
}
function oBytes(bs) {
  oEnsure(bs.length);
  outArena.set(bs, outLen);
  outLen += bs.length;
}
function oByte(c) {
  oEnsure(1);
  outArena[outLen++] = c;
}
let oStrBuf = new Uint8Array(256);
function oStr(s) {
  if (s === '') return;
  const need = s.length * 4 + 4;
  if (need > oStrBuf.length) oStrBuf = new Uint8Array(need * 2);
  const w = encB.encodeInto(s, oStrBuf).written;
  oSet(oStrBuf, 0, w);
}
function wcWord() {
  if (!wcInWord) { wcInWord = true; wcWords++; }
}
// Whether the UTF-8 char starting at byte i (lead byte) is a JS-\s space.
// Byte patterns for WS_TABLE's non-ASCII entries (160, 5760, 8192-8202,
// 8232, 8233, 8239, 8287, 12288, 65279).
function isUniSpaceB(u, i, b) {
  const c = u[i];
  if (c === 0xC2) return i + 1 < b && u[i + 1] === 0xA0;
  if (c === 0xE1) return i + 2 < b && u[i + 1] === 0x9A && u[i + 2] === 0x80;
  if (c === 0xE2) {
    if (i + 2 >= b) return false;
    const d1 = u[i + 1], d2 = u[i + 2];
    if (d1 === 0x80 && (d2 <= 0x8A || d2 === 0xA8 || d2 === 0xA9 || d2 === 0xAF)) return true;
    return d1 === 0x81 && d2 === 0x9F;
  }
  if (c === 0xE3) return i + 2 < b && u[i + 1] === 0x80 && u[i + 2] === 0x80;
  if (c === 0xEF) return i + 2 < b && u[i + 1] === 0xBB && u[i + 2] === 0xBF;
  return false;
}
// Word-count contribution of the byte at i (shared wc state).
function wcByteAt(u, i, b) {
  const c = u[i];
  if (c < 128) {
    if (T256[c] & 2) wcInWord = false;
    else if (!wcInWord) { wcInWord = true; wcWords++; }
    return;
  }
  if (c < 0xC2) return; // continuation byte: part of the current char
  if (isUniSpaceB(u, i, b)) wcInWord = false;
  else if (!wcInWord) { wcInWord = true; wcWords++; }
}
// Decode one UTF-8 code point starting at byte i (for isContinuedB).
function utf8Cp(u, i, b) {
  const c = u[i];
  if (c < 128) return c;
  if (c >= 0xC2 && c < 0xE0) return i + 1 < b ? ((c & 0x1F) << 6) | (u[i + 1] & 0x3F) : c;
  if (c >= 0xE0 && c < 0xF0) return i + 2 < b ? ((c & 0x0F) << 12) | ((u[i + 1] & 0x3F) << 6) | (u[i + 2] & 0x3F) : c;
  if (c >= 0xF0) return i + 3 < b ? ((c & 0x07) << 18) | ((u[i + 1] & 0x3F) << 12) | ((u[i + 2] & 0x3F) << 6) | (u[i + 3] & 0x3F) : c;
  return c;
}
// HTML-escape a byte range into the arena; word counting is fused (the
// bytes are visited exactly once). Callers are fence bodies + code-span
// inners. Word-count logic is inlined (no wcByteAt call per byte).
function oEsc(u, a, b) {
  let plain = a;
  for (let i = a; i < b; i++) {
    const c = u[i];
    if (c < 128) {
      if (T256[c] & 2) wcInWord = false;
      else if (!wcInWord) { wcInWord = true; wcWords++; }
      if (ESC_T[c]) {
        if (i > plain) oSet(u, plain, i);
        oBytes(ENT_BY_CODE[c]);
        plain = i + 1;
      }
    } else if (c >= 0xC2) {
      if (isUniSpaceB(u, i, b)) wcInWord = false;
      else if (!wcInWord) { wcInWord = true; wcWords++; }
    }
  }
  if (plain < b) oSet(u, plain, b);
}

function isEscapedB(u, j, from) {
  let k = j - 1, odd = false;
  while (k >= from && u[k] === 92) { odd = !odd; k--; }
  return odd;
}
// First occurrence of the byte pair (b1,b2) in [from, to), whole in range,
// not backslash-escaped; or -1. Mirror of findUnescaped(s, '**', ...).
function findPairB(u, b1, b2, from, to) {
  let j = u.indexOf(b1, from);
  while (j !== -1 && j + 1 < to) {
    if (u[j + 1] === b2 && !isEscapedB(u, j, from)) return j;
    j = u.indexOf(b1, j + 1);
  }
  return -1;
}
// First occurrence of byte b1 in [from, to), not escaped; or -1.
// Mirror of findUnescaped(s, ']', ...).
function findByteB(u, b1, from, to) {
  let j = u.indexOf(b1, from);
  while (j !== -1 && j < to && isEscapedB(u, j, from)) j = u.indexOf(b1, j + 1);
  return (j !== -1 && j < to) ? j : -1;
}
// First single '*' in [from, to) (run is not '**'), not escaped; or -1.
// Mirror of findSingleStar.
function findSingleStarB(u, from, to) {
  let j = u.indexOf(42, from);
  while (j !== -1 && j < to) {
    if (isEscapedB(u, j, from)) { j = u.indexOf(42, j + 1); continue; }
    if (j + 1 < to && u[j + 1] === 42) { j = u.indexOf(42, j + 2); continue; }
    return j;
  }
  return -1;
}

// Bytes [a, b) rendered inline into outArena. Mirror of v14 inlineRange,
// over bytes, with word counting fused (shared wc state; recursive calls
// count too — a construct's inner whitespace creates word boundaries the
// top-level loop never visits, so counting must happen at every level).
function inlineB(u, a, b, cx) {
  let i = a, plain = a;
  while (i < b) {
    const c = u[i];
    if (c < 128) {
      const t = T256[c];
      if (t === 2) { wcInWord = false; i++; continue; }
      if (t === 0) { if (!wcInWord) { wcInWord = true; wcWords++; } i++; continue; }
      if (c === 92) {
        if (i + 1 < b) {
          const d = u[i + 1];
          if (d < 128 && ESCAPABLE_TABLE[d]) {
            wcWord();
            if (i > plain) oSet(u, plain, i);
            if (d === 62) oBytes(B_GT); else oByte(d);
            i += 2; plain = i;
            continue;
          }
        }
        wcWord();
        i++;
        continue;
      }
      if (c === 96) {
        const k = u.indexOf(96, i + 1);
        if (k !== -1 && k < b && k > i + 1) {
          wcWord();
          if (i > plain) oSet(u, plain, i);
          oBytes(B_CODE_OPEN);
          oEsc(u, i + 1, k);
          oBytes(B_CODE_CLOSE);
          wcWord();
          i = k + 1; plain = i;
        } else {
          wcWord();
          i++;
        }
        continue;
      }
      if (c === 42) {
        if (i + 1 < b && u[i + 1] === 42) {
          const k = findPairB(u, 42, 42, i + 2, b);
          if (k !== -1 && k > i + 2) {
            wcWord();
            if (i > plain) oSet(u, plain, i);
            oBytes(B_STRONG_OPEN);
            inlineB(u, i + 2, k, cx);
            oBytes(B_STRONG_CLOSE);
            wcWord(); wcWord();
            i = k + 2; plain = i;
          } else {
            wcWord();
            i += 2;
          }
          continue;
        }
        const k = findSingleStarB(u, i + 1, b);
        if (k !== -1 && k > i + 1) {
          wcWord();
          if (i > plain) oSet(u, plain, i);
          oBytes(B_EM_OPEN);
          inlineB(u, i + 1, k, cx);
          oBytes(B_EM_CLOSE);
          wcWord();
          i = k + 1; plain = i;
        } else {
          wcWord();
          i++;
        }
        continue;
      }
      if (c === 91) {
        const k = findByteB(u, 93, i + 1, b);
        const m2 = k !== -1 && k + 1 < b && u[k + 1] === 40 ? u.indexOf(41, k + 2) : -1;
        const hasTarget = m2 !== -1 && m2 < b;
        let target = '';
        if (hasTarget) target = decB.decode(u.subarray(k + 2, m2));
        if (hasTarget && target !== '' && !WS_TARGET.test(target)) {
          wcWord();
          if (i > plain) oSet(u, plain, i);
          oBytes(B_A_OPEN);
          oStr(esc(resolveHref(target, cx)));
          oBytes(B_A_MID);
          inlineB(u, i + 1, k, cx);
          oBytes(B_A_CLOSE);
          wcWord();
          i = m2 + 1; plain = i;
        } else {
          wcWord();
          i++;
        }
        continue;
      }
      // esc-only special (& < > " ')
      wcWord();
      if (i > plain) oSet(u, plain, i);
      oBytes(ENT_BY_CODE[c]);
      i++; plain = i;
      continue;
    }
    wcByteAt(u, i, b);
    i++;
  }
  if (plain < b) oSet(u, plain, b);
}

// ---------- byte block helpers (mirrors of the string versions) ----------
function lineEndB(u, pos, n) {
  const nl = u.indexOf(10, pos);
  return nl === -1 || nl >= n ? n : nl;
}
function isBlankRangeB(u, a, b) {
  for (let k = a; k < b; k++) {
    const c = u[k];
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function trimRangeB(u, a, b) {
  while (a < b && (u[a] === 32 || u[a] === 9)) a++;
  while (b > a && (u[b - 1] === 32 || u[b - 1] === 9)) b--;
  return [a, b];
}
function fenceOpenB(u, a, b) {
  if (a + 2 >= b || u[a] !== 96 || u[a + 1] !== 96 || u[a + 2] !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = u[i];
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const ls = a + 3, le = i;
  while (i < b && (u[i] === 32 || u[i] === 9)) i++;
  return i === b ? { s: ls, e: le } : null;
}
function fenceCloseB(u, a, b) {
  if (a + 2 >= b || u[a] !== 96 || u[a + 1] !== 96 || u[a + 2] !== 96) return false;
  let i = a + 3;
  while (i < b && (u[i] === 32 || u[i] === 9)) i++;
  return i === b;
}
function headingOfB(u, a, b) {
  let hashes = 0;
  while (a + hashes < b && u[a + hashes] === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  let i = a + hashes;
  if (i >= b || (u[i] !== 32 && u[i] !== 9)) return null;
  while (i < b && (u[i] === 32 || u[i] === 9)) i++;
  let end = b;
  while (end > i && (u[end - 1] === 32 || u[end - 1] === 9)) end--;
  if (end === i) return null;
  return { depth: hashes, ta: i, tb: end };
}
function isHRB(u, a, b) {
  if (b - a < 3) return false;
  const c0 = u[a];
  if (c0 !== 45 && c0 !== 42) return false;
  if (u[a + 1] !== c0 || u[a + 2] !== c0) return false;
  for (let i = a + 3; i < b; i++) {
    const c = u[i];
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function bulletOfB(u, a, b) {
  const c = u[a];
  if ((c === 45 || c === 42) && a + 1 < b && u[a + 1] === 32) return a + 2;
  return -1;
}
function orderedOfB(u, a, b) {
  let i = a;
  while (i < b && u[i] >= 48 && u[i] <= 57) i++;
  if (i === a || i - a > 9) return null;
  if (i + 1 >= b || u[i] !== 46 || u[i + 1] !== 32) return null;
  let num = 0;
  for (let q = a; q < i; q++) num = num * 10 + (u[q] - 48);
  return [num, i + 2];
}
function endsParagraphB(u, a, b) {
  if (a === b) return true;
  const c0 = u[a];
  if (c0 === 32 || c0 === 9) return isBlankRangeB(u, a, b);
  if (c0 === 96) return fenceOpenB(u, a, b) !== null;
  if (c0 === 35) return headingOfB(u, a, b) !== null;
  if (c0 === 45 || c0 === 42) return isHRB(u, a, b);
  return false;
}
function isContinuedB(u, a, b) {
  let k = a;
  while (k < b && u[k] === 32) k++;
  return k - a >= 2 && k < b && !isWSCode(utf8Cp(u, k, b));
}
// Copy trimmed line ranges into scratchB joined by '\n'; returns length.
function scratchJoin(u, ranges) {
  let o = 0;
  for (let r = 0; r < ranges.length; r++) {
    const a = ranges[r][0], b = ranges[r][1];
    if (r > 0) {
      if (o + 1 > scratchB.length) {
        const nb = new Uint8Array(Math.max(o + 1, scratchB.length * 2));
        nb.set(scratchB.subarray(0, o));
        scratchB = nb;
      }
      scratchB[o++] = 10;
    }
    if (o + (b - a) > scratchB.length) {
      const nb = new Uint8Array(Math.max(o + (b - a), scratchB.length * 2));
      nb.set(scratchB.subarray(0, o));
      scratchB = nb;
    }
    scratchB.set(u.subarray(a, b), o);
    o += b - a;
  }
  return o;
}

// `content` rendered from char offset `bodyStartChar`: byte-level mirror of
// renderMdStr. Returns { html, toc, excerpt, words }.
function renderMdBytes(content, bodyStartChar, cx) {
  // Encode the whole content into the reusable input arena.
  let need = content.length + 1024;
  if (need > inArena.length) inArena = new Uint8Array(need * 2);
  let r = encB.encodeInto(content, inArena);
  while (r.read < content.length) {
    const nb = new Uint8Array(inArena.length * 2);
    r = encB.encodeInto(content, nb);
    inArena = nb;
  }
  const u = inArena, n = r.written;
  // Byte offset of bodyStartChar: line-scan for the closing '---' line
  // (parseFMRange already validated the front matter, so the close exists).
  let bodyStartByte = -1;
  const firstNL = u.indexOf(10, 0);
  if (firstNL !== -1) {
    let p = firstNL + 1;
    while (p < n) {
      const e = u.indexOf(10, p);
      const le = e === -1 ? n : e;
      if (le - p === 3 && u[p] === 45 && u[p + 1] === 45 && u[p + 2] === 45) {
        bodyStartByte = e === -1 ? n : e + 1;
        break;
      }
      if (e === -1) break;
      p = e + 1;
    }
  }
  if (bodyStartByte === -1) {
    // Should not happen (front matter validated); fall back to the string
    // path rather than risk a wrong answer.
    const words = wordsOfRange(content, bodyStartChar, content.length);
    const md = renderMdStr(content, bodyStartChar, cx);
    return { html: md.html, toc: md.toc, excerpt: md.excerpt, words };
  }
  const md = renderMdStrB(u, bodyStartByte, n, cx);
  const html = outLen === 0 ? '' : decB.decode(outArena.subarray(0, outLen));
  return { html, toc: md.toc, excerpt: md.excerpt, words: wcWords };
}

function renderMdStrB(u, start, n, cx) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let blockCount = 0;
  outLen = 0;
  wcWords = 0; wcInWord = false;
  let p = start;
  while (p < n) {
    const a = p;
    const b = lineEndB(u, p, n);
    const nx = b === n ? n : b + 1;
    const c0 = a < b ? u[a] : -1;
    wcInWord = false; // every line starts after '\n' (or body start)
    if (a === b || c0 === 32 || c0 === 9) {
      if (a === b || isBlankRangeB(u, a, b)) {
        p = nx;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpenB(u, a, b);
      if (lang !== null) {
        wcWord(); // '```lang' is one word run
        wcInWord = false;
        p = nx;
        oBytes(B_PRE_CODE);
        if (lang.e > lang.s) {
          oBytes(B_CLASS_LANG);
          oStr(esc(decB.decode(u.subarray(lang.s, lang.e))));
          oByte(34);
        }
        oByte(62);
        let closed = false;
        while (p < n) {
          const ba = p;
          const bb = lineEndB(u, p, n);
          if (fenceCloseB(u, ba, bb)) {
            wcWord(); // '```' close line is one word run
            p = bb === n ? n : bb + 1;
            closed = true;
            break;
          }
          wcInWord = false;
          oEsc(u, ba, bb);
          oByte(10);
          wcInWord = false;
          p = bb === n ? n : bb + 1;
        }
        if (!closed && n > 0 && u[n - 1] === 10) oByte(10);
        oBytes(B_PRE_CODE_CLOSE);
        oByte(10);
        blockCount++;
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOfB(u, a, b);
      if (heading !== null) {
        wcWord(); // the '#' run is one word run
        wcInWord = false; // the space after the hashes
        const text = decB.decode(u.subarray(heading.ta, heading.tb));
        const id = uniqueSlug(slugifyCached(text), ids);
        oStr('<h' + heading.depth + ' id="' + id + '">');
        const hs = outLen;
        inlineB(u, heading.ta, heading.tb, cx);
        const he = outLen;
        oStr('</h' + heading.depth + '>');
        oByte(10);
        blockCount++;
        if (heading.depth === 2 || heading.depth === 3) {
          toc.push({ level: heading.depth, id, html: decB.decode(outArena.subarray(hs, he)) });
        }
        p = nx;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHRB(u, a, b)) {
        wcWord(); // '---' / '***' is one word run
        oBytes(B_HR);
        oByte(10);
        blockCount++;
        p = nx;
        continue;
      }
    } else if (c0 === 62) {
      const ranges = [];
      let q = a;
      while (q < n) {
        const qb = lineEndB(u, q, n);
        if (qb === q || u[q] !== 62) break;
        wcInWord = false; // each quote line starts after '\n'
        wcWord(); // '>' per line is one word run
        let s = q + 1;
        if (s < qb && u[s] === 32) s++;
        const tr = trimRangeB(u, s, qb);
        if (tr[0] < tr[1]) ranges.push(tr);
        q = qb === n ? n : qb + 1;
      }
      p = q;
      if (ranges.length === 0) {
        oBytes(B_BQ_EMPTY);
      } else {
        oBytes(B_BQ_OPEN);
        scratchLenCur = scratchJoin(u, ranges);
        wcInWord = false;
        inlineB(scratchB, 0, scratchLenCur, cx);
        oBytes(B_BQ_CLOSE);
      }
      oByte(10);
      blockCount++;
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? bulletOfB(u, a, b) : -1;
    const ordered = bullet === -1 && c0 >= 48 && c0 <= 57 ? orderedOfB(u, a, b) : null;
    if (bullet !== -1 || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (p < n) {
        const la = p;
        const lb = lineEndB(u, p, n);
        const lnx = lb === n ? n : lb + 1;
        wcInWord = false; // each list line starts after '\n'
        let m = false;
        let textStart = -1;
        if (isOrdered) {
          const o = orderedOfB(u, la, lb);
          if (o !== null) {
            m = true;
            textStart = o[1];
          }
        } else {
          textStart = bulletOfB(u, la, lb);
          if (textStart !== -1) m = true;
        }
        if (m) {
          wcWord(); // the '- ' / '* ' / 'N. ' marker is one word run
          wcInWord = false;
          const tr = trimRangeB(u, textStart, lb);
          items.push([tr]);
          p = lnx;
        } else if (isContinuedB(u, la, lb)) {
          const tr = trimRangeB(u, la, lb);
          items[items.length - 1].push(tr);
          p = lnx;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const startNum = isOrdered ? ordered[0] : 1;
      if (isOrdered && startNum !== 1) oStr('<ol start="' + startNum + '">');
      else oBytes(isOrdered ? B_OL_OPEN : B_UL_OPEN);
      oByte(10);
      for (const parts of items) {
        oBytes(B_LI_OPEN);
        scratchLenCur = scratchJoin(u, parts);
        wcInWord = false;
        inlineB(scratchB, 0, scratchLenCur, cx);
        oBytes(B_LI_CLOSE);
      }
      oBytes(isOrdered ? B_OL_CLOSE : B_UL_CLOSE);
      oByte(10);
      blockCount++;
      continue;
    }
    const tr0 = trimRangeB(u, a, b);
    const ranges = [tr0];
    p = nx;
    while (p < n) {
      const la = p;
      const lb = lineEndB(u, p, n);
      if (endsParagraphB(u, la, lb)) break;
      const tr = trimRangeB(u, la, lb);
      ranges.push(tr);
      p = lb === n ? n : lb + 1;
    }
    oBytes(B_P_OPEN);
    const es = outLen;
    scratchLenCur = scratchJoin(u, ranges);
    wcInWord = false;
    inlineB(scratchB, 0, scratchLenCur, cx);
    const ee = outLen;
    oBytes(B_P_CLOSE);
    oByte(10);
    blockCount++;
    if (excerpt === null) excerpt = decB.decode(outArena.subarray(es, ee));
  }
  return { toc, excerpt: excerpt ?? '' };
}

// ---------- build ----------
// \r\n and lone \r -> \n, natively. (String.replace resets a /g regex's
// lastIndex, so the shared literal is safe to reuse.)
const CR_RE = /\r\n?/g;

export function run(input) {
  const site = input.site;
  let base = site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const report = new Set();
  const out = {};

  // templates (sorted names; parse order irrelevant to output)
  const tpls = {};
  const tnames = Object.keys(input.templates).sort();
  for (const name of tnames) {
    const r = parseTpl(input.templates[name]);
    if (r.err) report.add('template "' + name + '": ' + r.err);
    else tpls[name] = r.ops;
  }

  const files = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pages = []; // page records, source order
  const pageMap = new Map(); // source path -> url
  const staticSet = new Set();
  const statics = [];
  const takenByDir = new Map();

  for (const f of files) {
    const path = f.path;
    if (!path.endsWith('.md')) { statics.push(f); staticSet.add(path); continue; }
    const content = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CR_RE, '\n');
    const r = parseFMRange(content);
    if (r.err) { report.add('refused ' + path + ': ' + r.err); continue; }
    const fm = r.fm;
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash);
    const isPost = dir === 'posts' || dir.startsWith('posts/');
    const top = dir.split('/')[0];
    if (top === 'tags' || top === 'page') { report.add('refused ' + path + ': ' + top + '/ is the generator\'s own'); continue; }
    if (isPost && !fm.date) { report.add('refused ' + path + ': a post needs a date'); continue; }
    const layoutName = fm.layout || (isPost ? 'post' : 'page');
    if (!tpls[layoutName]) { report.add('refused ' + path + ': layout "' + layoutName + '" is no template that parses'); continue; }
    if (fm.draft === true) { report.add('draft ' + path); continue; }
    const pdir = isPost ? 'posts' : dir;
    let slug = fm.slug || slugOf(fm.title);
    let taken = takenByDir.get(pdir);
    if (!taken) {
      taken = new Set();
      if (pdir === '') { taken.add('posts'); taken.add('tags'); taken.add('page'); }
      takenByDir.set(pdir, taken);
    }
    let s = slug, k = 2;
    while (taken.has(s)) s = slug + '-' + k++;
    taken.add(s);
    const outPath = (pdir ? pdir + '/' : '') + s + '/index.html';
    const url = base + '/' + (pdir ? pdir + '/' : '') + s + '/';
    pageMap.set(path, url);
    pages.push({ path, dir, isPost, slug: s, outPath, url, title: fm.title, date: fm.date || '', summary: fm.summary || '', tags: fm.tags || [], layout: layoutName, bodyStart: r.bodyStart, content });
  }

  // collections: posts newest first, equal dates by slug
  const posts = pages.filter(p => p.isPost).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i > 0 ? posts[i - 1] : null;
    posts[i].older = i < posts.length - 1 ? posts[i + 1] : null;
  }

  // tags registry (collection order, first spelling kept)
  const reg = new Map();
  for (const p of posts) {
    const seen = new Set();
    for (const t of p.tags) {
      const sl = slugOf(t);
      if (seen.has(sl)) continue;
      seen.add(sl);
      let e = reg.get(sl);
      if (!e) { e = { name: t, slug: sl, posts: [] }; reg.set(sl, e); }
      e.posts.push(p);
    }
  }
  const tagList = [...reg.values()].sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (const t of tagList) t.url = base + '/tags/' + t.slug + '/';
  for (const t of tagList) t.count = t.posts.length;

  // render markdown for every page (needs pageMap/staticSet; cx per source)
  // Loop frames are preallocated once and mutated in place; the inline
  // stack is reused across inl() calls. `tags` and `recent` are the same
  // for every page, so they are built once here instead of once per page.
  const frames = [];
  for (let f = 0; f < 8; f++) frames.push({ name: '', item: undefined, loop: { index: 0, first: false, last: false, length: 0 } });
  // Memoization safety (global): if ANY template names a loop variable
  // site/tags/recent/loop, that name would shadow the run-constant ctx key
  // of the same name inside the loop's scope (dynamic shadow check in
  // resolveBind) — so no for-op may be memoized in this run at all.
  let memoOk = true;
  for (const n of tnames) if (/\{%\s*for\s+(site|tags|recent|loop)\s+in\s/.test(input.templates[n])) { memoOk = false; break; }
  const cx = { ctx: {}, templates: tpls, pageMap, staticSet, base, report, src: '', dir: '', frames, top: 0, memoOk };
  for (const p of pages) {
    cx.src = p.path;
    cx.dir = p.dir;
    // v20 byte-level markdown: encode once, single pass over bytes
    // (block + inline + word count + esc fused), decode the page HTML.
    const md = renderMdBytes(p.content, p.bodyStart, cx);
    p.content = md.html;
    p.excerpt = md.excerpt;
    p.toc = md.toc;
    p.reading = Math.max(1, Math.ceil(md.words / 200));
  }

  function card(p) {
    const tags = [];
    const seen = new Set();
    for (const t of p.tags) {
      const sl = slugOf(t);
      if (seen.has(sl)) continue;
      seen.add(sl);
      const e = reg.get(sl);
      tags.push(e ? { name: e.name, slug: sl, url: e.url } : { name: t, slug: sl, url: '' });
    }
    return { title: p.title, url: p.url, date: p.date, date_long: p.date ? dateLong(p.date) : '', summary: p.summary, excerpt: p.excerpt, reading_minutes: p.reading, tags };
  }

  const cardByPage = new Map();
  for (const p of pages) cardByPage.set(p, card(p));

  function pageObj(p) {
    const c = cardByPage.get(p);
    return {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long, summary: c.summary,
      excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: p.slug, content: p.content, toc: p.toc,
      newer: p.newer ? { title: p.newer.title, url: p.newer.url, date: p.newer.date, date_long: p.newer.date ? dateLong(p.newer.date) : '' } : null,
      older: p.older ? { title: p.older.title, url: p.older.url, date: p.older.date, date_long: p.older.date ? dateLong(p.older.date) : '' } : null,
      is_post: p.isPost
    };
  }

  // Shared across every rendered page (read-only during rendering).
  const tagObjs = tagList.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));
  const recentCards = posts.slice(0, site.recent).map(q => cardByPage.get(q));
  // One ctx object per run, mutated per page (never replaced): the site
  // sub-object is the same values for every page, so it is built once.
  // Rendering is synchronous per page, so no render ever sees another
  // page's ctx.
  const siteObj = { title: site.title, base_url: base };
  const ctx = cx.ctx = { site: siteObj, page: undefined, tags: tagObjs, recent: recentCards, posts: undefined, pager: undefined, tag: undefined };

  // render pages (source order)
  for (const p of pages) {
    ctx.page = pageObj(p); ctx.posts = undefined; ctx.pager = undefined; ctx.tag = undefined;
    out[p.outPath] = renderStr(tpls[p.layout], frames, 0, cx);
  }

  // index pages
  const per = site.per_page;
  const nPosts = posts.length;
  const total = Math.max(1, Math.ceil(nPosts / per));
  if (tpls['index']) {
    for (let i = 1; i <= total; i++) {
      const slice = posts.slice((i - 1) * per, i * per).map(q => cardByPage.get(q));
      const pager = {
        number: i, total,
        url: i === 1 ? base + '/' : base + '/page/' + i + '/',
        newer_url: i > 1 ? (i - 1 === 1 ? base + '/' : base + '/page/' + (i - 1) + '/') : '',
        older_url: i < total ? base + '/page/' + (i + 1) + '/' : ''
      };
      ctx.page = undefined; ctx.posts = slice; ctx.pager = pager; ctx.tag = undefined;
      out[i === 1 ? 'index.html' : 'page/' + i + '/index.html'] = renderStr(tpls['index'], frames, 0, cx);
    }
  }

  // tag pages + tags index
  if (tpls['tag']) {
    for (const t of tagList) {
      ctx.page = undefined; ctx.posts = undefined; ctx.pager = undefined;
      ctx.tag = { name: t.name, slug: t.slug, url: t.url, count: t.count, posts: t.posts.map(q => cardByPage.get(q)) };
      out['tags/' + t.slug + '/index.html'] = renderStr(tpls['tag'], frames, 0, cx);
    }
  }
  if (tpls['tags']) {
    ctx.page = undefined; ctx.posts = undefined; ctx.pager = undefined; ctx.tag = undefined;
    out['tags/index.html'] = renderStr(tpls['tags'], frames, 0, cx);
  }

  // static files
  let nStatic = statics.length;
  for (const f of statics) {
    if (Object.hasOwn(out, f.path)) { report.add('shadowed ' + f.path + ': a built page has its path'); continue; }
    out[f.path] = f.content;
  }

  // report
  const nPages = pages.filter(p => !p.isPost).length;
  const nPostCount = posts.length;
  const lines = [...report].sort();
  let rep = '';
  for (const l of lines) rep += l + '\n';
  rep += 'built ' + nPages + ' pages, ' + nPostCount + ' posts, ' + tagList.length + ' tags and ' + nStatic + ' static files\n';
  out['build-report.txt'] = rep;
  return out;
}
