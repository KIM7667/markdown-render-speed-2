// A dependency-free Markdown renderer (CommonMark + GFM) written from scratch.
// parse(markdown) returns the HTML for the document. No external packages.

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isPunct(ch) { return ch !== undefined && ASCII_PUNCT.has(ch); }

// Escaping model (matches the reference renderer):
// - text: numeric character references are decoded to characters (invalid
//   ones become U+FFFD), named references pass through untouched, and
//   & < > " ' are escaped.
// - code: everything escaped, no reference preservation.
// - attributes: entity-looking &...; sequences are preserved, bare & and
//   < > " ' are escaped.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC_TEXT = /&(?:#(\d{1,7});|#[xX]([0-9a-fA-F]{1,6});|([A-Za-z][A-Za-z0-9]*);)|[<>"']|&/g;
function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(RE_ESC_TEXT, (m, dec, hex) => {
    if (m.charCodeAt(0) === 38) {
      if (dec !== undefined || hex !== undefined) {
        let cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
        if (!(cp > 0) || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
        const ch = String.fromCodePoint(cp);
        return ESC_MAP[ch] || ch;
      }
      if (m.length > 1) return m; // named reference: pass through
      return '&amp;';
    }
    return ESC_MAP[m];
  });
}

// Escape everything for code content.
function escapeCode(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape an attribute value (double-quoted), preserving entity references.
const RE_ESC_ATTR = /&(?:#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]*;)|[<>"']|&/g;
function escapeAttr(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(RE_ESC_ATTR, (m) => {
    if (m.charCodeAt(0) === 38 && m.length > 1) return m;
    return ESC_MAP[m];
  });
}

// marked-style URL cleanup: percent-encode like encodeURI but keep existing
// %-escapes intact.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Line helpers. A "line" here is a string without its trailing \n.
// Columns count a tab as advancing to the next multiple of 4.

function indentOf(line) {
  // number of leading spaces, counting a tab as 4 (only for the common
  // all-spaces / single-tab prefixes; general case handled by colOf)
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') n++;
    else if (c === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

// After a tab has been partially consumed, the tabs left in the leading
// whitespace run must be materialized as spaces on the original column
// grid, or later column math would misjudge their widths.
function expandLeadingTabs(s, startCol) {
  if (!s.includes('\t')) return s;
  let out = '';
  let col = startCol;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out + s.slice(i);
}

// Remove up to `cols` columns of indentation from the start of a line.
// Returns the remainder of the line.
function dedent(line, cols) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else {
        // partial tab: remainder is (w - (cols-col)) spaces + rest
        return expandLeadingTabs(' '.repeat(w - (cols - col)) + line.slice(i + 1), cols);
      }
    } else break;
  }
  return line.slice(i);
}

const RE_BLANK = /^[ \t]*$/;
function isBlank(line) { return RE_BLANK.test(line); }

// Marked-style list dedent: the whole leading whitespace run is expanded to
// spaces on the original tab grid first, then `cols` columns are removed —
// so a tab that starts exactly at the cut still contributes its width.
function dedentExpanded(line, cols) {
  let col = 0;
  let i = 0;
  let out = '';
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (col <= cols) return line.slice(i);
  return out.slice(cols) + line.slice(i);
}

// ---------------------------------------------------------------------------
// Block-level recognizers

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?[ \t]*$/;
const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_QUOTE = /^ {0,3}>/;
const RE_QUOTE_STRIP = /^ {0,3}> ?/;

function fenceStart(line) {
  const m = RE_FENCE.exec(line);
  if (!m) return null;
  const fence = m[1];
  const info = m[2].trim();
  if (fence[0] === '`' && info.includes('`')) return null;
  return { ch: fence[0], len: fence.length, info, indent: indentOf(line) };
}

function fenceEnd(line, f) {
  const m = RE_FENCE.exec(line);
  if (!m) return false;
  if (m[1][0] !== f.ch || m[1].length < f.len) return false;
  return m[2].trim() === '';
}

function atxHeading(line) {
  const m = RE_ATX.exec(line);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  // strip an optional closing sequence of #s
  if (/^#+[ \t]*$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+[ \t]*$/, '');
  return { depth: m[1].length, text: text.trim() === '' && text !== '' ? '' : text.replace(/[ \t]+$/, '') };
}

// List marker at start of line (after up to 3 spaces indent).
// Returns { ordered, bullet, num, markerEnd, contentIndent } or null.
// markerEnd = index just past marker + following spaces (the column where
// item content begins, capped by the 1..4 space rule).
function listMarker(line) {
  let i = 0;
  let indent = 0;
  while (i < line.length && line[i] === ' ' && indent < 4) { i++; indent++; }
  if (indent > 3) return null;
  // a tab in the indent: treat via column math on the whole line
  const rest = line.slice(i);
  let m = /^([-+*])([ \t]|$)/.exec(rest);
  let ordered = false, num = 0, markerLen = 0, delim = '';
  if (m) {
    markerLen = 1; delim = m[1];
  } else {
    m = /^(\d{1,9})([.)])([ \t]|$)/.exec(rest);
    if (!m) return null;
    ordered = true; num = parseInt(m[1], 10); markerLen = m[1].length + 1; delim = m[2];
  }
  const afterMarker = i + markerLen;
  // count spaces/tabs after marker up to content
  let spaces = 0, j = afterMarker;
  let col = indent + markerLen;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { spaces++; col++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; }
    j++;
  }
  const blankRest = j >= line.length;
  let contentCol;
  if (blankRest) contentCol = indent + markerLen + 1;
  else if (spaces >= 1 && spaces <= 4) contentCol = col;
  else if (spaces === 0) return null; // no space after marker (e.g. "-foo" handled by regex requiring [ \t]|$; $ case is blankRest)
  else contentCol = indent + markerLen + 1; // 5+ spaces: content indented one past marker
  return { ordered, delim, num, indent, markerCol: indent, contentCol, blankRest };
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Returns 'script'|'comment'|'pi'|'decl'|'cdata'|'tag'|'any' or null for an
// HTML block starting at this line. `interrupt` says whether it may interrupt
// a paragraph (types 1-6 may; type 7 may not).
function htmlBlockStart(line) {
  const m = /^ {0,3}</.exec(line);
  if (!m) return null;
  const s = line.slice(m[0].length);
  if (/^(script|pre|style|textarea)(?=[ \t>]|$)/i.test(s)) return 'script';
  if (s.startsWith('!--')) return 'comment';
  if (s.startsWith('?')) return 'pi';
  if (/^![A-Za-z]/.test(s)) return 'decl';
  if (s.startsWith('![CDATA[')) return 'cdata';
  const tag = /^(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (tag) {
    const name = tag[2].toLowerCase();
    const after = s.slice(tag[0].length);
    // a closing script/pre/style/textarea tag never opens an HTML block
    if (tag[1] === '/' && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) return null;
    if (HTML_BLOCK_TAGS.has(name) && /^(?:[ \t>]|\/>|$)/.test(after)) return 'tag';
    // type 7: the line consists of exactly one complete, valid tag
    const whole = '<' + s;
    const tm = RE_TAG_CLOSE.exec(whole) || RE_TAG_OPEN.exec(whole);
    if (tm && /^[ \t]*$/.test(whole.slice(tm[0].length))) return 'any';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link reference definitions

// Parse a link reference definition starting at lines[i]. The label, the
// destination and the title may each span lines (one newline of separation
// is allowed before the destination and before the title).
// Returns { label, href, title, next } or null.
function matchDef(lines, i) {
  if (!/^ {0,3}\[/.test(lines[i])) return null;
  const WIN = 12;
  const text = lines.slice(i, i + WIN).join('\n');
  let pos = 0;
  while (text[pos] === ' ') pos++;
  if (text[pos] !== '[') return null;
  pos++;
  let label = '';
  let ok = false;
  while (pos < text.length) {
    const c = text[pos];
    if (c === '\\' && pos + 1 < text.length) { label += text[pos] + text[pos + 1]; pos += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { ok = true; break; }
    if (c === '\n') {
      // a label may not span a blank line
      let q = pos + 1;
      while (text[q] === ' ' || text[q] === '\t') q++;
      if (q >= text.length || text[q] === '\n') return null;
    }
    label += c; pos++;
  }
  if (!ok || label.length > 999 || label.trim() === '') return null;
  pos++;
  if (text[pos] !== ':') return null;
  pos++;
  // whitespace before the destination: spaces/tabs and at most one newline
  let sawNl = false;
  for (;;) {
    const c = text[pos];
    if (c === ' ' || c === '\t') { pos++; continue; }
    if (c === '\n' && !sawNl) { sawNl = true; pos++; continue; }
    break;
  }
  let href;
  if (text[pos] === '<') {
    let j = pos + 1; let okd = false;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '>') { okd = true; break; }
      if (c === '<' || c === '\n') break;
      j++;
    }
    if (!okd) return null;
    href = text.slice(pos + 1, j);
    pos = j + 1;
  } else {
    let depth = 0, j = pos;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n') break;
      j++;
    }
    if (j === pos) return null;
    href = text.slice(pos, j);
    pos = j;
  }
  // optional title: try the title form first; if it does not parse, the
  // definition may still be valid with no title (the title-looking line is
  // then left for normal block parsing)
  const afterDest = pos;
  let title = null;
  let endPos = -1;
  {
    let p2 = pos, sep = false, sawNl2 = false;
    for (;;) {
      const c = text[p2];
      if (c === ' ' || c === '\t') { sep = true; p2++; continue; }
      if (c === '\n' && !sawNl2) { sawNl2 = true; sep = true; p2++; continue; }
      break;
    }
    const tc = text[p2];
    if ((tc === '"' || tc === "'" || tc === '(') && sep) {
      const close = tc === '(' ? ')' : tc;
      let j = p2 + 1; let okt = false;
      while (j < text.length) {
        const ch = text[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === close) { okt = true; break; }
        if (tc === '(' && ch === '(') break;
        if (ch === '\n') {
          // a title may not span a blank line
          let q = j + 1;
          while (text[q] === ' ' || text[q] === '\t') q++;
          if (q >= text.length || text[q] === '\n') break;
        }
        j++;
      }
      if (okt) {
        let p3 = j + 1;
        while (text[p3] === ' ' || text[p3] === '\t') p3++;
        if (p3 >= text.length || text[p3] === '\n') { title = text.slice(p2 + 1, j); endPos = p3; }
      }
    }
  }
  if (endPos === -1) {
    let p2 = afterDest;
    while (text[p2] === ' ' || text[p2] === '\t') p2++;
    if (p2 < text.length && text[p2] !== '\n') return null;
    endPos = p2;
    title = null;
  }
  pos = endPos;
  const nlTotal = (text.slice(0, pos).match(/\n/g) || []).length;
  const consumed = nlTotal === 0 ? 1 : (text[pos - 1] === '\n' ? nlTotal : nlTotal + 1);
  return { label, href: unescapeStr(href), title: title === null ? null : unescapeStr(title), next: i + consumed };
}

function normalizeLabel(label) {
  // labels match literally (backslash escapes stay as written), modulo
  // whitespace collapsing and Unicode case folding
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\u00df/g, 'ss').replace(/\u03c2/g, '\u03c3');
}

// ---------------------------------------------------------------------------
// Tables

// Split a table row into raw cell strings, honoring \| and code spans.
// Returns null when the line contains no pipe at all.
function splitRow(line) {
  if (!line.includes('|')) return null;
  let s = line.trim();
  // leading pipe
  let start = 0;
  if (s[start] === '|') start = 1;
  const cells = [];
  let cur = '';
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1] === '|' ? '|' : c + s[i + 1]; i += 2; continue; }
    if (c === '|') {
      cells.push(cur); cur = ''; i++; continue;
    }
    cur += c; i++;
  }
  cells.push(cur);
  // trailing pipe creates an empty final cell: drop it
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && /^\s*$/.test(cells[cells.length - 1])) cells.pop();
  return cells.map(c => c.trim());
}

function delimiterAligns(line) {
  const cells = splitRow(line);
  if (!cells || cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.startsWith(':')) aligns.push('left');
    else if (c.endsWith(':')) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// If lines[i] + lines[i+1] open a table, return { aligns, header } else null.
function tableStart(lines, i) {
  if (i + 1 >= lines.length) return null;
  const aligns = delimiterAligns(lines[i + 1]);
  if (!aligns) return null;
  const header = splitRow(lines[i]);
  if (!header || header.length !== aligns.length) return null;
  return { aligns, header };
}

// ---------------------------------------------------------------------------
// Block parsing. Input: array of lines (no trailing \n). ctx: { refs }.
// protect: optional Set of line indices (within `lines`) that must not act
// as setext underlines (used by blockquote laziness handling).

function parseBlocks(lines, ctx, protect, top, lazySet) {
  const tokens = [];
  const n = lines.length;
  let i = 0;
  // `spaced` reports whether any two consecutive blocks were separated by
  // blank lines at this level (drives list looseness); captures report how
  // many blank lines they swallowed past their last content line.
  let spaced = false;
  let sep = false;
  // a consumed link reference definition counts as an invisible element for
  // spacing: an item holding a block, a blank line, and a def is loose
  let defSeen = false;
  const push = (tok, blanksAfter) => {
    if ((tokens.length > 0 || defSeen) && sep) spaced = true;
    tokens.push(tok);
    sep = blanksAfter > 0;
  };
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { if (tokens.length > 0 || defSeen) sep = true; i++; continue; }

    // fenced code
    const f = fenceStart(line);
    if (f) {
      const content = [];
      let j = i + 1;
      while (j < n && !fenceEnd(lines[j], f)) { content.push(lines[j]); j++; }
      const closed = j < n;
      if (closed) j++;
      // marked deviation: tilde fences do not strip their indent from
      // content lines; backtick fences strip up to the fence indent
      const stripped = f.ch === '~' ? content : content.map(l => dedent(l, Math.min(f.indent, 3)));
      let raw = stripped.map(l => l + '\n').join('');
      if (raw.endsWith('\n')) raw = raw.slice(0, -1);
      push({ t: 'code', text: raw, lang: f.info === '' ? null : unescapeStr(f.info).split(/\s+/)[0], fenced: true }, 0);
      i = j;
      continue;
    }

    // indented code
    if (indentOf(line) >= 4) {
      const content = [];
      let j = i;
      let lastContent = -1;
      while (j < n) {
        const l = lines[j];
        if (isBlank(l)) { content.push(indentOf(l) > 4 ? dedent(l, 4) : ''); j++; continue; }
        if (indentOf(l) >= 4) { content.push(dedent(l, 4)); lastContent = content.length - 1; j++; continue; }
        break;
      }
      const trailingBlanks = content.length - 1 - lastContent;
      content.length = lastContent + 1;
      push({ t: 'code', text: content.join('\n'), lang: null, fenced: false }, trailingBlanks);
      i = j;
      continue;
    }

    // ATX heading
    const h = atxHeading(line);
    if (h) { push({ t: 'heading', depth: h.depth, text: h.text }, 0); i++; continue; }

    // thematic break
    if (RE_HR.test(line)) { push({ t: 'hr' }, 0); i++; continue; }

    // blockquote
    if (RE_QUOTE.test(line)) {
      const q = captureBlockquote(lines, i, ctx);
      push({ t: 'blockquote', tokens: q.tokens }, 0);
      i = q.next;
      continue;
    }

    // list
    const lm = listMarker(line);
    if (lm) {
      const lst = parseList(lines, i, ctx);
      push(lst.token, lst.blanksAfter || 0);
      i = lst.next;
      continue;
    }

    // HTML block
    const hb = htmlBlockStart(line);
    if (hb) {
      const r = captureHtmlBlock(lines, i, hb);
      const tok = { t: 'html', text: r.text, kind: hb };
      // the raw block keeps its trailing newline when the following line
      // is non-blank, or at the very end of a newline-terminated document;
      // a blank separator line (or a container boundary) swallows it
      const termKind = hb === 'script' || hb === 'comment' || hb === 'pi' || hb === 'decl' || hb === 'cdata';
      tok.nlAfter = r.next < lines.length ? (termKind ? lines[r.next] !== '' : false) : (!!top && !!ctx.docEndsNl);
      push(tok, 0);
      i = r.next;
      continue;
    }

    // link reference definition(s)
    const def = matchDef(lines, i);
    if (def) {
      if ((tokens.length > 0 || defSeen) && sep) spaced = true;
      defSeen = true;
      sep = false;
      const key = normalizeLabel(def.label);
      if (!ctx.refs.has(key)) ctx.refs.set(key, { href: def.href, title: def.title });
      i = def.next;
      continue;
    }

    // table
    const ts = tableStart(lines, i);
    if (ts) {
      const rows = [];
      let j = i + 2;
      while (j < n && !/^ *$/.test(lines[j]) && !RE_QUOTE.test(lines[j]) && !paragraphInterruptedBy(lines, j, ctx) && !matchDef(lines, j)) {
        const cells = splitRow(lines[j]) || [lines[j].trim()];
        while (cells.length < ts.aligns.length) cells.push('');
        rows.push(cells.slice(0, ts.aligns.length));
        j++;
      }
      push({ t: 'table', header: ts.header, aligns: ts.aligns, rows }, 0);
      i = j;
      continue;
    }

    // paragraph (with setext / table / interrupt handling)
    const p = captureParagraph(lines, i, ctx, protect, lazySet);
    if (p.heading) push({ t: 'heading', depth: p.heading, text: p.lines.join('\n').trim() }, 0);
    else push({ t: 'paragraph', text: p.lines.join('\n').split(WS_SENTINEL).join('') }, 0);
    i = p.next;
  }
  return { tokens, spaced };
}

// Does this line interrupt a paragraph in progress?
function paragraphInterruptedBy(lines, j, ctx) {
  const line = lines[j];
  if (fenceStart(line)) return true;
  if (atxHeading(line)) return true;
  if (RE_HR.test(line)) return true;
  if (RE_QUOTE.test(line)) return true;
  const hb = htmlBlockStart(line);
  if (hb && hb !== 'any') return true;
  const lm = listMarker(line);
  if (lm) {
    // a list interrupts a paragraph: bullet always; ordered only from 1 at
    // top level (any number inside list item content); item must be non-empty
    if (!lm.blankRest && (!lm.ordered || lm.num === 1 || ctx.inList)) return true;
  }
  return false;
}

function captureParagraph(lines, i, ctx, protect, lazySet) {
  const plines = [lines[i]];
  const n = lines.length;
  let j = i + 1;
  while (j < n) {
    const line = lines[j];
    if (isBlank(line)) break;
    if (RE_SETEXT.test(line) && !(protect && protect.has(j))) {
      // whole paragraph becomes a heading
      return { lines: plines, next: j + 1, heading: line.trimStart().startsWith('=') ? 1 : 2 };
    }
    // a lazy continuation line always joins the paragraph (it was only
    // captured because a paragraph is open here)
    if (lazySet && lazySet.has(j)) { plines.push(line); j++; continue; }
    if (tableStart(lines, j)) break;
    if (paragraphInterruptedBy(lines, j, ctx)) break;
    plines.push(line);
    j++;
  }
  return { lines: plines, next: j, heading: 0 };
}

function captureHtmlBlock(lines, i, kind) {
  const out = [lines[i]];
  let j = i + 1;
  const n = lines.length;
  // terminator kinds end as soon as a line contains the closing marker,
  // possibly the first line itself
  let term = null;
  if (kind === 'script') {
    const tag = /^ {0,3}<(script|pre|style|textarea)/i.exec(lines[i])[1].toLowerCase();
    const close = new RegExp('</' + tag + '>', 'i');
    term = (l) => close.test(l);
  } else if (kind === 'comment') term = (l) => l.includes('-->');
  else if (kind === 'pi') term = (l) => l.includes('?>');
  else if (kind === 'decl') term = (l) => l.includes('>');
  else if (kind === 'cdata') term = (l) => l.includes(']]>');
  if (term) {
    if (!term(lines[i])) {
      while (j < n) { out.push(lines[j]); j++; if (term(out[out.length - 1])) break; }
    }
  } else {
    while (j < n && !isBlank(lines[j])) { out.push(lines[j]); j++; }
  }
  return { text: out.join('\n'), next: j };
}

// ---------------------------------------------------------------------------
// Blockquote capture. Collects quoted lines plus lazy paragraph-continuation
// lines, strips the markers, and lexes the inside.

function captureBlockquote(lines, i, ctx) {
  const n = lines.length;
  const inner = [];      // stripped line texts
  const lazy = [];       // parallel: was this line a lazy (unmarked) line?
  let j = i;
  while (j < n) {
    const line = lines[j];
    if (RE_QUOTE.test(line)) {
      inner.push(quoteInner(line));
      lazy.push(false);
      j++;
      continue;
    }
    if (isBlank(line)) break;
    // lazy continuation: only directly after a non-blank quoted line,
    // while the content so far ends in a paragraph, and the line does not
    // interrupt a paragraph
    if (inner.length === 0) break;
    if (isBlank(inner[inner.length - 1])) break;
    if (!endsInParagraph(inner, ctx)) break;
    if (paragraphInterruptedBy(lines, j, ctx)) break;
    inner.push(indentOf(line) >= 4 ? dedent(line, 4) : line);
    lazy.push(true);
    j++;
  }
  // Setext-laziness adjustments, mirroring the reference renderer's habits:
  // a lazy setext underline after a one-line paragraph stays paragraph text
  // (protect it); after a multi-line paragraph whose previous line was also
  // lazy it is indented by four spaces in the paragraph text.
  const protect = new Set();
  for (let k = 1; k < inner.length; k++) {
    if (!lazy[k]) continue;
    if (!RE_SETEXT.test(inner[k])) continue;
    if (RE_HR.test(inner[k])) continue; // dashes are handled by interrupt rules
    // count consecutive non-blank inner lines directly above k
    let p = 0;
    for (let m = k - 1; m >= 0 && !isBlank(inner[m]); m--) p++;
    if (p === 1) protect.add(k);
    else if (p >= 2 && lazy[k - 1]) inner[k] = '    ' + inner[k];
  }
  // a trailing whitespace-only quoted line joins the final paragraph
  // instead of acting as a blank separator
  if (inner.length >= 2) {
    const last = inner[inner.length - 1];
    if (last !== '' && isBlank(last) && !isBlank(inner[inner.length - 2])) {
      inner[inner.length - 1] = WS_SENTINEL + last;
    }
  }
  const lazySet = new Set();
  for (let k = 0; k < inner.length; k++) if (lazy[k]) lazySet.add(k);
  const tokens = parseBlocks(inner, ctx, protect, false, lazySet).tokens;
  return { tokens, next: j };
}

// Lex the given lines and report whether the deepest trailing block is a
// paragraph (so a lazy line may continue it).
function endsInParagraph(lines, ctx) {
  // use a scratch refs copy so probing does not register definitions
  const probeCtx = { refs: new Map(ctx.refs) };
  const toks = parseBlocks(lines, probeCtx, null).tokens;
  return lastIsParagraph(toks);
}

function lastIsParagraph(toks) {
  if (toks.length === 0) return false;
  const last = toks[toks.length - 1];
  if (last.t === 'paragraph') return true;
  if (last.t === 'blockquote') return lastIsParagraph(last.tokens);
  if (last.t === 'list') {
    if (last.items.length === 0) return false;
    return lastIsParagraph(last.items[last.items.length - 1].tokens);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lists

function parseList(lines, i, ctx) {
  const n = lines.length;
  const first = listMarker(lines[i]);
  const items = [];
  let loose = false;
  let j = i;
  let endBlanks = 0;
  const start = first.num;
  while (j < n) {
    if (j > i && RE_HR.test(lines[j])) break; // a thematic break ends the list
    const lm = listMarker(lines[j]);
    if (!lm) break;
    if (lm.ordered !== first.ordered || lm.delim !== first.delim) break;
    if (lm.indent > 3) break;
    // collect this item's lines
    const contentIndent = lm.contentCol;
    const itemLines = [];
    // text after marker on the first line: everything from contentCol
    itemLines.push({ text: sliceAtCol(lines[j], contentIndent), blank: false });
    // an open fence inside the item keeps consuming lines (even ones not
    // indented to the item) until it closes, as marked's item scan does
    let fence = fenceStart(itemLines[0].text);
    let fenceFed = false; // a fence that has taken a proper content line
    j++;
    let pendingBlanks = 0;
    while (j < n) {
      const line = lines[j];
      if (fence) {
        // fence content lines join the item when blank or indented to the
        // item's content column; once the fence has taken one proper
        // content line, later lines join at any indent until it closes —
        // but a fence whose first content line falls short ends the item
        // and is left unclosed
        if (!isBlank(line) && indentOf(line) < contentIndent && !fenceFed) break;
        if (!isBlank(line) && indentOf(line) >= contentIndent) fenceFed = true;
        const text = dedentExpanded(line, contentIndent);
        itemLines.push({ text, blank: isBlank(line) });
        if (fenceEnd(text, fence)) fence = null;
        j++;
        continue;
      }
      if (isBlank(line)) { pendingBlanks++; j++; continue; }
      // an item that is still empty when a blank line intervenes is over
      if (pendingBlanks > 0 && itemLines.every(x => isBlank(x.text))) break;
      const nm = listMarker(line);
      if (nm && nm.indent <= 3 && nm.ordered === first.ordered && nm.delim === first.delim && indentOf(line) < contentIndent) {
        break; // next item
      }
      if (indentOf(line) >= contentIndent) {
        // belongs to the item
        if (pendingBlanks > 0) {
          for (let b = 0; b < pendingBlanks; b++) itemLines.push({ text: '', blank: true });
          pendingBlanks = 0;
        }
        itemLines.push({ text: dedentExpanded(line, contentIndent), blank: false });
        fence = fenceStart(itemLines[itemLines.length - 1].text);
        fenceFed = false;
        j++;
        continue;
      }
      // not indented enough: a list marker line always ends the item (it
      // either starts the next item or ends this list); other lines may be
      // lazy paragraph continuations
      if (listMarker(line)) break;
      if (pendingBlanks === 0 && itemLines.length > 0 && endsInParagraph(itemLines.map(x => x.text), ctx) && !paragraphInterruptedBy(lines, j, ctx)) {
        itemLines.push({ text: indentOf(line) >= 4 ? dedent(line, 4) : line, blank: false, lazy: true });
        j++;
        continue;
      }
      break;
    }
    if (pendingBlanks > 0 && j < n) {
      // blank lines separate items only when another item of this list
      // actually follows
      const nm2 = listMarker(lines[j]);
      if (nm2 && nm2.ordered === first.ordered && nm2.delim === first.delim) loose = true;
    }
    endBlanks = pendingBlanks;
    const subLines = itemLines.map(x => x.text);
    const itemLazy = new Set();
    itemLines.forEach((x, xi) => { if (x.lazy) itemLazy.add(xi); });
    // marked deviation: inside list item content, an ordered list with any
    // start number interrupts a paragraph (at top level only 1 does)
    const itemCtx = ctx.inList ? ctx : { ...ctx, inList: true };
    const sub = parseBlocks(subLines, itemCtx, null, false, itemLazy);
    if (sub.spaced) loose = true;
    items.push({ tokens: sub.tokens });
    if (j >= n) break;
    // if the next line is not a matching marker, the list is over
    const nm = listMarker(lines[j]);
    if (!nm || nm.ordered !== first.ordered || nm.delim !== first.delim) break;
  }
  return { token: { t: 'list', ordered: first.ordered, start, loose, items }, next: j, blanksAfter: endBlanks };
}

// Slice a line at a visual column (the prefix may contain non-space
// characters, e.g. a list marker). Tabs advance to the next multiple of 4;
// a tab straddling the column leaves the remainder as spaces, and any tabs
// left in the leading run are expanded on the original column grid.
function sliceAtCol(line, col) {
  let c = 0;
  let i = 0;
  while (i < line.length && c < col) {
    if (line[i] === '\t') {
      const w = 4 - (c % 4);
      if (c + w <= col) { c += w; i++; }
      else return expandLeadingTabs(' '.repeat(w - (col - c)) + line.slice(i + 1), col);
    } else { c++; i++; }
  }
  return line.slice(i);
}

// The content of a blockquote line after its marker: up to 3 spaces, '>',
// and one optional space (a tab counts and is partially consumed).
function quoteInner(line) {
  // strip '>' plus one optional space column (a tab in that slot is only
  // partly consumed), then expand the content's leading whitespace run to
  // spaces on this line's own tab grid — marked's blockquote habit; the
  // recursion into nested quotes therefore sees a fresh grid per level
  let idx = 0;
  let col = 0;
  while (line[idx] === ' ') { idx++; col++; }
  idx++; col++; // the '>'
  let prefix = '';
  if (line[idx] === ' ') { idx++; col++; }
  else if (line[idx] === '\t') {
    const w = 4 - (col % 4);
    prefix = ' '.repeat(w - 1);
    col += w;
    idx++;
  }
  let rest = '';
  while (idx < line.length) {
    const c = line[idx];
    if (c === ' ') { rest += ' '; col++; idx++; }
    else if (c === '\t') { const w = 4 - (col % 4); rest += ' '.repeat(w); col += w; idx++; }
    else break;
  }
  return prefix + rest + line.slice(idx);
}

// ---------------------------------------------------------------------------
// Inline parsing

const ESC_AMP = '\uE001'; // placeholder for a backslash-escaped &
const WS_SENTINEL = '\uE003'; // marks a trailing whitespace-only quote line
const RE_AUTOLINK_URI = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const RE_AUTOLINK_EMAIL = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const RE_TAG_OPEN = /^<([A-Za-z][A-Za-z0-9-]*)((?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*)[ \t\n]*(\/?)>/;
const RE_TAG_CLOSE = /^<\/([A-Za-z][A-Za-z0-9-]*)[ \t\n]*>/;
const RE_EMAIL_EXT = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)+/;
const EMAIL_LOCAL_CHAR = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

function isSpaceCh(ch) {
  if (ch === undefined) return true;
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' ||
    ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') ||
    ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' || ch === '\u3000' || ch === '\ufeff';
}
const RE_PUNCT_U = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  if (ch === undefined) return false;
  return RE_PUNCT_U.test(ch);
}

// Unescape backslash-escaped punctuation in a destination/title/label string.
function unescapeStr(s) {
  return s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// Parse an inline link target starting just after '(' at src[pos].
// Returns { href, title, end } (end = index just past ')') or null.
function parseLinkTarget(src, pos) {
  let i = pos;
  const n = src.length;
  const skipWs = () => { while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++; };
  skipWs();
  let href;
  if (src[i] === '<') {
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '>') { ok = true; break; }
      if (c === '<' || c === '\n') break;
      j++;
    }
    if (!ok) return null;
    href = src.slice(i + 1, j);
    i = j + 1;
  } else {
    let depth = 0, j = i;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      j++;
    }
    href = src.slice(i, j);
    i = j;
  }
  skipWs();
  let title = null;
  const q = src[i];
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    let j = i + 1, ok = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === close) { ok = true; break; }
      if (q === '(' && c === '(') break;
      j++;
    }
    if (!ok) return null;
    title = src.slice(i + 1, j);
    i = j + 1;
    skipWs();
  }
  if (src[i] !== ')') return null;
  return { href: unescapeStr(href), title: title === null ? null : unescapeStr(title), end: i + 1 };
}

// Trim an extended-autolink candidate the way marked's matcher does: the
// match is the longest prefix of the candidate that is a sequence of units
// (single chars, or balanced non-nested paren groups) and ends with a
// group or a char that is not trailing punctuation. An unmatched '(' ends
// the match before it; an unmatched ')' can be consumed mid-match but the
// match cannot end on it; a trailing entity-looking '&word;' is excluded
// whole.
function trimAutolink(url) {
  let best = 0;
  let ampStart = -1;   // index of a '&' that may begin an entity suffix
  let ampBest = 0;     // best value before that '&'
  let i = 0;
  const n = url.length;
  while (i < n) {
    const ch = url[i];
    if (ch === '(') {
      let j = i + 1;
      while (j < n && url[j] !== '(' && url[j] !== ')') j++;
      if (j < n && url[j] === ')') { i = j + 1; best = i; ampStart = -1; continue; }
      break;
    }
    if (ch === '&') { if (ampStart === -1) { ampStart = i; ampBest = best; } }
    else if (ch === ';' && ampStart !== -1 && /^[A-Za-z0-9]+$/.test(url.slice(ampStart + 1, i))) {
      best = ampBest; ampStart = -1; i++; continue;
    } else if (!/[A-Za-z0-9]/.test(ch)) ampStart = -1;
    i++;
    if (!'?!.,:*_~;)'.includes(ch)) best = i;
  }
  return url.slice(0, best);
}

function parseInline(src, ctx) {
  const nodes = [];
  const delims = [];   // { node, char, len, canOpen, canClose }
  const openers = [];  // { node, image, active, contentStart }
  let buf = '';
  const flush = () => { if (buf !== '') { nodes.push({ kind: 'text', text: buf }); buf = ''; } };
  // marked tracks a document-wide inLink state: an inline <a> opening tag
  // (even self-closing, any case) suppresses extended autolinks until </a>
  const pushHtml = (text) => {
    if (/^<a [^>]*>/i.test(text)) ctx.shared.inLink = true;
    else if (/^<\/a\s*>$/i.test(text)) ctx.shared.inLink = false;
    flush(); nodes.push({ kind: 'html', text });
  };
  const n = src.length;
  let i = 0;

  const prevCharAt = (pos) => pos > 0 ? src[pos - 1] : undefined;

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush(); nodes.push({ kind: 'br' });
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) { buf += nx === '&' ? ESC_AMP : nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }

    if (c === '\n') {
      // hard break when preceded by 2+ spaces; the break eats the newline
      // and any indentation of the following line
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ kind: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }

    if (c === '`') {
      let run = 0;
      while (i + run < n && src[i + run] === '`') run++;
      // find a closing run of exactly `run` backticks; inside brackets the
      // search stops at the next ']' (marked tokenizes link text separately,
      // so a code span cannot cross the bracket boundary)
      let j = i + run, closeAt = -1;
      let limit = n;
      let bounded = false;
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k].linkOk && openers[k].active) { limit = openers[k].closeIdx; bounded = true; break; }
      }
      if (!bounded && openers.length && run >= 2) {
        const rb = src.indexOf(']', i + run);
        if (rb !== -1) limit = rb;
      }
      while (j < limit) {
        if (src[j] === '`') {
          let r = 0;
          while (j + r < n && src[j + r] === '`') r++;
          if (r === run) { closeAt = j; break; }
          j += r;
        } else j++;
      }
      if (closeAt !== -1 && closeAt + run > limit) closeAt = -1;
      if (closeAt === -1) { buf += src.slice(i, i + run); i += run; continue; }
      flush();
      let content = src.slice(i + run, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ kind: 'code', text: content });
      i = closeAt + run;
      continue;
    }

    if (c === '<') {
      const rest = src.slice(i);
      let m = RE_AUTOLINK_URI.exec(rest);
      if (m) {
        flush();
        nodes.push({ kind: 'link', href: m[1], title: null, children: [{ kind: 'text', text: m[1] }], autolink: true });
        i += m[0].length; continue;
      }
      m = RE_AUTOLINK_EMAIL.exec(rest);
      if (m) {
        flush();
        nodes.push({ kind: 'link', href: 'mailto:' + m[1], title: null, children: [{ kind: 'text', text: m[1] }], autolink: true });
        i += m[0].length; continue;
      }
      if (rest.startsWith('<!--')) {
        // marked also accepts the abrupt empty comments <!--> and <!--->
        if (rest.startsWith('<!-->')) { pushHtml('<!-->'); i += 5; continue; }
        if (rest.startsWith('<!--->')) { pushHtml('<!--->'); i += 6; continue; }
        const end = rest.indexOf('-->', 4);
        if (end !== -1) {
          pushHtml(rest.slice(0, end + 3)); i += end + 3; continue;
        }
      }
      if (rest.startsWith('<?')) {
        const end = rest.indexOf('?>', 2);
        if (end !== -1) { pushHtml(rest.slice(0, end + 2)); i += end + 2; continue; }
      }
      if (rest.startsWith('<![CDATA[')) {
        const end = rest.indexOf(']]>', 9);
        if (end !== -1) { pushHtml(rest.slice(0, end + 3)); i += end + 3; continue; }
      }
      m = /^<![A-Za-z][^>]*>/.exec(rest);
      if (m) { pushHtml(m[0]); i += m[0].length; continue; }
      m = RE_TAG_CLOSE.exec(rest) || RE_TAG_OPEN.exec(rest);
      if (m) { pushHtml(m[0]); i += m[0].length; continue; }
      buf += '<'; i++; continue;
    }

    if (c === '!' && src[i + 1] === '[') {
      flush();
      const node = { kind: 'opener', image: true };
      nodes.push(node);
      openers.push({ node, image: true, active: true, contentStart: i + 2, ...linkLookahead(src, i + 2, ctx) });
      i += 2; continue;
    }

    if (c === '[') {
      flush();
      const node = { kind: 'opener', image: false };
      nodes.push(node);
      openers.push({ node, image: false, active: true, contentStart: i + 1, ...linkLookahead(src, i + 1, ctx) });
      i++; continue;
    }

    if (c === ']') {
      flush();
      if (openers.length === 0) { buf += ']'; i++; continue; }
      const op = openers[openers.length - 1];
      if (!op.active) {
        // an inactive opener blocks this ']': it can never match, and no
        // earlier opener may be reached past it
        openers.pop();
        buf += ']'; i++; continue;
      }
      const formed = tryFormLink(src, i, op, nodes, delims, ctx);
      if (formed !== null) {
        openers.pop();
        if (!op.image) {
          // a formed link deactivates all earlier link openers
          for (const o of openers) if (!o.image) o.active = false;
        }
        i = formed;
        continue;
      }
      // failed: this opener can never match; drop it, ']' is literal
      openers.pop();
      buf += ']'; i++; continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let run = 0;
      while (i + run < n && src[i + run] === c) run++;
      if (c === '~' && run > 2) { buf += src.slice(i, i + run); i += run; continue; }
      flush();
      const node = { kind: 'delim', char: c, len: run };
      nodes.push(node);
      const prev = prevCharAt(i);
      const next = i + run < n ? src[i + run] : undefined;
      const prevWs = isSpaceCh(prev), nextWs = isSpaceCh(next);
      const prevP = isPunctCh(prev), nextP = isPunctCh(next);
      const leftFlank = !nextWs && (!nextP || prevWs || prevP);
      const rightFlank = !prevWs && (!prevP || nextWs || nextP);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else if (c === '_') {
        canOpen = leftFlank && (!rightFlank || prevP);
        canClose = rightFlank && (!leftFlank || nextP);
      } else { // ~
        canOpen = leftFlank && !nextWs;
        canClose = rightFlank && !prevWs;
      }
      delims.push({ node, char: c, len: run, origLen: run, canOpen, canClose });
      i += run; continue;
    }

    // extended autolinks in plain text
    if ((c === 'w' || c === 'h' || EMAIL_LOCAL_CHAR.test(c))) {
      const prev = prevCharAt(i);
      const boundary = prev === undefined || isSpaceCh(prev) || (isPunctCh(prev) && prev !== '.' && prev !== '@' && prev !== '/' && prev !== '-');
      if (boundary && !ctx.shared.inLink) {
        const rest = src.slice(i);
        let m = null, href = null, disp = null;
        // scheme-prefixed forms: mailto:addr and xmpp:addr[/segment]; the
        // address must be complete (a following - or _ invalidates it)
        const scheme = rest.startsWith('mailto:') ? 'mailto:' : (rest.startsWith('xmpp:') ? 'xmpp:' : null);
        if (scheme) {
          const em = RE_EMAIL_EXT.exec(rest.slice(scheme.length));
          if (em) {
            const endPos = scheme.length + em[0].length;
            const nx = rest[endPos];
            if (nx !== '-' && !(nx === '_' && !delims.some(d => d.char === '_' && d.canOpen && d.len > 0))) {
              let cand = scheme + em[0];
              if (scheme === 'xmpp:' && nx === '/') {
                const seg = /^\/+[^\s<>]+/.exec(rest.slice(endPos));
                if (seg) {
                  let segText = seg[0];
                  const secondSlash = segText.indexOf('/', 1);
                  if (secondSlash !== -1) segText = segText.slice(0, secondSlash);
                  if (segText.length > 1) cand += segText;
                }
              }
              disp = trimAutolink(cand);
              href = disp;
              m = disp;
            }
          }
        }
        if (!m && rest.startsWith('www.')) {
          let raw = /^[^\s<]+/.exec(rest)[0];
          if (openers.some(o => o.active)) { const cut = raw.indexOf(']'); if (cut !== -1) raw = raw.slice(0, cut); }
          disp = trimAutolink(raw);
          if (disp.length > 4 && disp.includes('.', 4)) { href = 'http://' + disp; m = disp; }
        } else if (!m && /^https?:\/\//i.test(rest)) {
          let raw = /^[^\s<]+/.exec(rest)[0];
          if (openers.some(o => o.active)) { const cut = raw.indexOf(']'); if (cut !== -1) raw = raw.slice(0, cut); }
          disp = trimAutolink(raw);
          const schemeLen = /^https?:\/\//i.exec(rest)[0].length;
          if (disp.length > schemeLen) { href = disp; m = disp; }
        }
        if (!m && EMAIL_LOCAL_CHAR.test(c) && (prev === undefined || (!EMAIL_LOCAL_CHAR.test(prev) && prev !== '.' && prev !== '@'))) {
          const em = RE_EMAIL_EXT.exec(rest);
          if (em) {
            const nx = rest[em[0].length];
            if (nx !== '-' && !(nx === '_' && !delims.some(d => d.char === '_' && d.canOpen && d.len > 0))) { disp = em[0]; href = 'mailto:' + disp; m = disp; }
          }
        }
        if (m) {
          flush();
          nodes.push({ kind: 'link', href, title: null, children: [{ kind: 'text', text: disp }], autolink: true, ext: true });
          i += m.length; continue;
        }
      }
    }

    buf += c; i++;
  }
  flush();
  processEmphasis(nodes, delims);
  return nodes;
}

function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.kind === 'link' && !nd.autolink) return true;
    if (nd.children && containsLink(nd.children)) return true;
  }
  return false;
}

// Find the ']' that closes a label starting at `start` (just after '['),
// counting nested brackets (backslash escapes skipped).
function scanLabelEnd(src, start) {
  let depth = 1;
  let j = start;
  const n = src.length;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// Marked's link matcher rejects a label whose backticks are not
// self-contained: exactly one unpaired backtick run, or a completed span
// of 2+ backticks whose content holds a backtick — unless that span is the
// last thing in the label or another complete span follows it.
function labelTicksOk(label) {
  const n = label.length;
  let unpaired = 0;
  let j = 0;
  let badSpanEnd = -1;
  const spanEnds = [];
  while (j < n) {
    if (label[j] === '\\') { j += 2; continue; }
    if (label[j] !== '`') { j++; continue; }
    let run = 0;
    while (j + run < n && label[j + run] === '`') run++;
    let k = j + run, closeAt = -1;
    while (k < n) {
      if (label[k] === '\\') { k += 2; continue; }
      if (label[k] === '`') {
        let r = 0;
        while (k + r < n && label[k + r] === '`') r++;
        if (r === run) { closeAt = k; break; }
        k += r;
      } else k++;
    }
    if (closeAt === -1) { unpaired++; j += run; continue; }
    if (run >= 2 && label.slice(j + run, closeAt).includes('`') && badSpanEnd === -1) badSpanEnd = closeAt + run;
    spanEnds.push(closeAt + run);
    j = closeAt + run;
  }
  if (unpaired === 1) return false;
  if (badSpanEnd !== -1 && badSpanEnd < n && !spanEnds.some(e => e > badSpanEnd)) return false;
  return true;
}

// At a '[': decide whether marked's link matcher would accept the unit
// [label](target) or [label][label2]. Returns { linkOk, closeIdx }.
function linkLookahead(src, start, ctx) {
  const closeIdx = scanLabelEnd(src, start);
  if (closeIdx === -1) return { linkOk: false, closeIdx: -1 };
  const label = src.slice(start, closeIdx);
  const after = closeIdx + 1;
  if (src[after] === '(') {
    if (!labelTicksOk(label)) return { linkOk: false, closeIdx };
    return { linkOk: !!parseLinkTarget(src, after + 1), closeIdx };
  }
  if (src[after] === '[') {
    if (!labelTicksOk(label)) return { linkOk: false, closeIdx };
    let j = after + 1;
    let label2 = '';
    let ok = false;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\' && j + 1 < src.length) { label2 += src[j] + src[j + 1]; j += 2; continue; }
      if (ch === ']') { ok = true; break; }
      if (ch === '[') break;
      label2 += ch; j++;
    }
    if (!ok) return { linkOk: false, closeIdx };
    const useLabel = label2 === '' ? label : label2;
    return { linkOk: ctx.refs.has(normalizeLabel(useLabel)), closeIdx };
  }
  return { linkOk: false, closeIdx };
}

// Attempt to form a link/image at the ']' located at src[closeIdx], using
// opener `op`. On success, rewrites the node list and returns the new scan
// position (index into src). On failure returns null.
function tryFormLink(src, closeIdx, op, nodes, delims, ctx) {
  const nodeIdx = nodes.indexOf(op.node);
  if (nodeIdx === -1) return null;
  const after = closeIdx + 1;
  let href = null, title = null, end = -1;
  if (src[after] === '(') {
    if (!labelTicksOk(src.slice(op.contentStart, closeIdx))) return null;
    const t = parseLinkTarget(src, after + 1);
    if (t) { href = t.href; title = t.title; end = t.end; }
    else {
      // not a valid inline target: the brackets may still be a shortcut
      // reference, with the ( ... ) left as literal text
      const useLabel = src.slice(op.contentStart, closeIdx);
      if (useLabel === '') return null;
      const def = ctx.refs.get(normalizeLabel(useLabel));
      if (def) { href = def.href; title = def.title; end = after; }
      else if (src[after + 1] !== '<') {
        // marked deviation: a link-shaped unit whose target is invalid
        // (and does not start with '<') and whose label has no definition
        // is emitted as one literal text run — no inline parsing inside
        let depth = 0, e = -1;
        for (let k = after; k < src.length; k++) {
          const ch = src[k];
          if (ch === '\\') { k++; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) { e = k; break; } }
        }
        if (e === -1) return null;
        const children = nodes.splice(nodeIdx + 1);
        for (let k = delims.length - 1; k >= 0; k--) {
          if (children.includes(delims[k].node)) delims.splice(k, 1);
        }
        nodes.length = nodeIdx;
        const start = op.image ? op.contentStart - 2 : op.contentStart - 1;
        nodes.push({ kind: 'text', text: src.slice(start, e + 1) });
        return e + 1;
      }
      if (!def) return null;
    }
  } else if (src[after] === '[') {
    if (!labelTicksOk(src.slice(op.contentStart, closeIdx))) return null;
    // full or collapsed reference
    let j = after + 1;
    let label = '';
    let ok = false;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\' && j + 1 < src.length) { label += src[j] + src[j + 1]; j += 2; continue; }
      if (ch === ']') { ok = true; break; }
      if (ch === '[') break;
      label += ch; j++;
    }
    if (!ok) return null;
    const useLabel = label === '' ? src.slice(op.contentStart, closeIdx) : label;
    const def = ctx.refs.get(normalizeLabel(useLabel));
    if (!def) return null;
    href = def.href; title = def.title; end = j + 1;
  } else {
    // shortcut reference
    const useLabel = src.slice(op.contentStart, closeIdx);
    if (useLabel === '') return null;
    const def = ctx.refs.get(normalizeLabel(useLabel));
    if (!def) return null;
    href = def.href; title = def.title; end = after;
  }
  // gather children nodes after the opener
  const children = nodes.splice(nodeIdx + 1);
  if (!op.image && containsLink(children)) {
    // links cannot contain links: restore and fail
    nodes.push(...children);
    return null;
  }
  // extended autolinks do not survive inside link text: demote them back
  // to plain text (angle-bracket autolinks are unaffected)
  for (let k = 0; k < children.length; k++) {
    const nd = children[k];
    if (nd.kind === 'link' && nd.ext) children[k] = { kind: 'text', text: nd.children[0].text };
  }
  nodes.length = nodeIdx; // drop the opener itself
  // emphasis within the link text is resolved on its own stack slice
  const subDelims = [];
  for (let k = delims.length - 1; k >= 0; k--) {
    if (children.includes(delims[k].node)) { subDelims.unshift(delims[k]); delims.splice(k, 1); }
  }
  processEmphasis(children, subDelims);
  if (op.image) {
    nodes.push({ kind: 'image', href, title, children });
  } else {
    nodes.push({ kind: 'link', href, title, children });
  }
  return end;
}

// The CommonMark delimiter-run emphasis algorithm, with openers_bottom
// bookkeeping. Delimiter nodes live in `nodes`; a partially used run keeps
// its node with a reduced length.
function processEmphasis(nodes, delims) {
  const bottoms = new Map();
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len <= 0) { ci++; continue; }
    const key = closer.char + '|' + (closer.canOpen ? 'o' : 'x') + '|' + (closer.origLen % 3);
    const bottom = bottoms.has(key) ? bottoms.get(key) : null;
    // find the nearest usable opener below the closer (the bottom is a
    // delimiter identity: indices go stale as delimiters are consumed)
    let oi = ci - 1;
    let opener = null;
    while (oi >= 0 && delims[oi] !== bottom) {
      const op = delims[oi];
      if (op.char === closer.char && op.canOpen && op.len > 0 &&
          !(closer.char === '~' && closer.len < 1)) {
        // rule of three
        if ((closer.canOpen || op.canClose) &&
            (op.origLen + closer.origLen) % 3 === 0 &&
            (op.origLen % 3 !== 0 || closer.origLen % 3 !== 0)) { oi--; continue; }
        if (closer.char === '*') {
          const pUse = op.len >= 2 && closer.len >= 2 ? 2 : 1;
          // marked deviation (M3): a '*' run of length >= 2 immediately
          // followed by a '~' delimiter cannot close as an em (use 1),
          // though it may still close as a strong (use 2)
          if (pUse === 1 && closer.origLen === 2) {
            const ni = nodes.indexOf(closer.node);
            const nxt = ni === -1 ? null : nodes[ni + 1];
            if (nxt && nxt.kind === 'delim' && nxt.char === '~') { oi--; continue; }
          }
          const oNi = nodes.indexOf(op.node);
          const cNi = nodes.indexOf(closer.node);
          // marked deviation (M2a): a close-only single '*' does not pair
          // with a '**' opener when the inner em pair just formed closed
          // with a both-flanking '*'
          if (pUse === 1 && closer.origLen === 1 && op.origLen === 2 && oNi !== -1 && cNi > oNi) {
            let blocked = false;
            for (let k = oNi + 1; k < cNi; k++) {
              if (nodes[k].kind === 'em' && nodes[k].dchar === '*' && nodes[k].closerCanOpen) blocked = true;
            }
            if (blocked) { oi--; continue; }
          }
          if (oNi !== -1 && cNi > oNi) {
            // marked deviation (M1): an em whose content holds a strong
            // pair immediately followed by a word character never forms
            if (pUse === 1) {
              let blocked = false;
              for (let k = oNi + 1; k < cNi; k++) {
                const nd = nodes[k];
                if (nd.kind === 'strong' && nd.dchar === '*') {
                  const after = nodes[k + 1];
                  const before = nodes[k - 1];
                  if (after && after.kind === 'text' && /^[\p{L}\p{N}]/u.test(after.text) &&
                      before && before.kind === 'text' && /\s$/.test(before.text)) blocked = true;
                }
              }
              if (blocked) { oi--; continue; }
            }
            // marked deviation (M2b): a strong whose first inner em pair
            // closed with a both-flanking '*' forms only when a further
            // close-only single '*' follows inside (a '***' closer is exempt:
            // it forms the strong and keeps its leftover star inside, M4)
            if (pUse === 2 && closer.origLen === 2) {
              let emIdx = -1;
              for (let k = oNi + 1; k < cNi; k++) {
                if (nodes[k].kind === 'em' && nodes[k].dchar === '*') { emIdx = k; break; }
              }
              if (emIdx !== -1 && nodes[emIdx].closerCanOpen && !nodes[emIdx].openerCanClose) {
                let extra = null;
                for (let k = emIdx + 1; k < cNi; k++) {
                  const nd = nodes[k];
                  if (nd.kind === 'delim' && nd.char === '*' && nd.len === 1) {
                    const dd = delims.find(d => d.node === nd);
                    if (dd && (dd.canOpen || dd.canClose)) { extra = dd; break; }
                  }
                }
                if (!extra || extra.canOpen) { oi--; continue; }
              }
            }
          }
        }
        opener = op;
        break;
      }
      oi--;
    }
    if (!opener) {
      bottoms.set(key, ci > 0 ? delims[ci - 1] : null);
      ci++;
      continue;
    }
    const use = closer.char === '~' ? Math.min(opener.len, closer.len, 2) : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
    const oIdx = nodes.indexOf(opener.node);
    const cIdx = nodes.indexOf(closer.node);
    if (oIdx === -1 || cIdx === -1 || cIdx <= oIdx) { ci++; continue; }
    const between = nodes.splice(oIdx + 1, cIdx - oIdx - 1);
    const kind = closer.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    nodes.splice(oIdx + 1, 0, { kind, children: between, dchar: closer.char, closerCanOpen: closer.canOpen, openerCanClose: opener.canClose });
    if (kind === 'strong' && closer.char === '*' && closer.origLen === 3 && use === 2 && between.length >= 2) {
      const lastN = between[between.length - 1];
      const prevN = between[between.length - 2];
      if (lastN.kind === 'text' && /^[\p{L}\p{N}]/u.test(lastN.text) && prevN.kind === 'em' && prevN.dchar === '*') {
        between.push({ kind: 'delim', char: '*', len: 1 });
        closer.len -= 1; closer.node.len -= 1;
      }
    }
    // delimiter runs inside the wrap leave the stack
    for (let k = delims.length - 1; k >= 0; k--) {
      if (delims[k] !== opener && delims[k] !== closer && between.includes(delims[k].node)) {
        delims.splice(k, 1);
      }
    }
    ci = delims.indexOf(closer);
    opener.len -= use; closer.len -= use;
    opener.node.len -= use; closer.node.len -= use;
    if (opener.len <= 0) {
      const ni = nodes.indexOf(opener.node);
      if (ni !== -1) nodes.splice(ni, 1);
      delims.splice(delims.indexOf(opener), 1);
      ci = delims.indexOf(closer);
    }
    if (closer.len <= 0) {
      const ni = nodes.indexOf(closer.node);
      if (ni !== -1) nodes.splice(ni, 1);
      delims.splice(ci, 1);
      // ci stays: the next delimiter shifted into this slot
    }
    // a closer with length left loops again against earlier openers
  }
}

// Plain-text content of a node list (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.kind === 'text' || nd.kind === 'delim') out += nd.kind === 'text' ? nd.text.split(ESC_AMP).join('&') : nd.char.repeat(nd.len);
    else if (nd.kind === 'code') out += nd.text;
    else if (nd.kind === 'br') out += '\n';
    else if (nd.kind === 'html') { /* dropped */ }
    else if (nd.children) out += plainText(nd.children);
    else if (nd.kind === 'opener') out += nd.image ? '![' : '[';
  }
  return out;
}

function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text': out += escapeText(nd.text).split(ESC_AMP).join('&amp;'); break;
      case 'delim': out += escapeText(nd.char.repeat(nd.len)); break;
      case 'opener': out += nd.image ? '![' : '['; break;
      case 'code': out += '<code>' + escapeCode(nd.text) + '</code>'; break;
      case 'html': out += nd.text; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderInlineNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineNodes(nd.children) + '</del>'; break;
      case 'link': {
        const href = escapeAttr(cleanUrl(nd.href));
        const title = nd.title !== null && nd.title !== undefined ? ' title="' + escapeAttr(nd.title) + '"' : '';
        out += '<a href="' + href + '"' + title + '>' + renderInlineNodes(nd.children) + '</a>';
        break;
      }
      case 'image': {
        const src = escapeAttr(cleanUrl(nd.href));
        const title = nd.title !== null && nd.title !== undefined ? ' title="' + escapeAttr(nd.title) + '"' : '';
        out += '<img src="' + src + '" alt="' + escapeAttr(plainText(nd.children)) + '"' + title + '>';
        break;
      }
    }
  }
  return out;
}

function renderInline(text, ctx) {
  return renderInlineNodes(parseInline(text, ctx));
}

// ---------------------------------------------------------------------------
// Block rendering

function renderTokens(tokens, ctx, tight) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'heading':
        out += '<h' + tok.depth + '>' + renderInline(tok.text, ctx) + '</h' + tok.depth + '>\n';
        break;
      case 'paragraph':
        if (tight) out += renderInline(tok.text, ctx);
        else out += '<p>' + renderInline(tok.text, ctx) + '</p>\n';
        break;
      case 'code': {
        const cls = tok.lang ? ' class="language-' + escapeAttr(tok.lang) + '"' : '';
        const body = tok.text === '' ? '' : escapeCode(tok.text) + (tok.text.endsWith('\n') ? '' : '\n');
        out += '<pre><code' + cls + '>' + body + '</code></pre>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.tokens, ctx, false) + '</blockquote>\n';
        break;
      case 'html':
        out += tok.text + (tok.nlAfter ? '\n' : '');
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < tok.header.length; c++) {
          const al = tok.aligns[c];
          out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + renderInline(tok.header[c], ctx) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (tok.rows.length > 0) {
          const rowStrs = tok.rows.map(row =>
            '<tr>\n' + row.map((cell, c) => {
              const al = tok.aligns[c];
              return '<td' + (al ? ' align="' + al + '"' : '') + '>' + renderInline(cell, ctx) + '</td>\n';
            }).join('') + '</tr>');
          out += '<tbody>' + rowStrs.join('\n') + '\n</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + startAttr + '>\n';
        for (const item of tok.items) {
          out += '<li>' + renderListItem(item, ctx, tok.loose) + '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
    }
  }
  return out;
}

function renderListItem(item, ctx, loose) {
  const toks = item.tokens;
  if (toks.length > 0 && toks[0].t === 'paragraph') {
    const m = /^\[([ xX])\] /.exec(toks[0].text);
    if (m) {
      const checked = m[1] !== ' ';
      const input = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox">';
      const first = { ...toks[0], text: toks[0].text.slice(3) };
      if (loose) {
        return '<p>' + input + renderInline(first.text, ctx) + '</p>\n' + renderTokens(toks.slice(1), ctx, false);
      }
      return input + renderTokens([first, ...toks.slice(1)], ctx, true);
    }
  }
  if (loose) return renderTokens(toks, ctx, false);
  return renderTokens(toks, ctx, true);
}

// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const ctx = { refs: new Map(), shared: { inLink: false } };
  // the split artifact: a source ending in \n yields a phantom empty line;
  // drop it and remember the fact for raw-html trailing-newline rendering
  const endsNl = src.endsWith('\n');
  ctx.docEndsNl = endsNl;
  const lines = (endsNl ? src.slice(0, -1) : src).split('\n');
  const tokens = parseBlocks(lines, ctx, null, true).tokens;
  return renderTokens(tokens, ctx, false);
}
