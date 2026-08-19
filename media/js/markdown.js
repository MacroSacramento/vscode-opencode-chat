// ── Markdown renderer ────────────────────────────────────────────────────
// Dependency-free subset: headings, bold/italic, strikethrough, inline +
// fenced code (Prism-highlighted), nested/task lists, GFM pipe tables,
// blockquotes, hr. All source text is escaped before anything else so
// user/assistant content can never inject markup. The only intentional
// unescaped outputs are Prism's highlight HTML and whitelisted link hrefs.

import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-php';
// prism-php registers an unguarded after-tokenize hook that calls
// markup-templating.tokenizePlaceholders for every highlight — without this
// component loaded, highlighting ANY language throws.
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-kotlin';

// We call Prism.highlight() directly on freshly rendered code blocks; disable
// Prism's auto-highlight DOM pass so it never scans the page for code
// elements (there are none at DOMContentLoaded, but this makes that
// impossible rather than merely unlikely).
Prism.manual = true;

export function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Turns escaped text into clickable links. Safe: the input is already
// HTML-escaped, so nothing can inject markup through the href (and the
// regex only matches `http(s)://`).
export function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// Whitelisted URL schemes for markdown link hrefs. Anything else
// (`javascript:`, `data:`, `file:`, `vbscript:`, ...) is rejected and
// renders as plain text so it can never end up in an href.
export function safeLinkHref(url) {
  const m = String(url).match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) {
    return null;
  }
  const scheme = m[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
    return url;
  }
  return null;
}

// Fence language → Prism language id. Unknown/absent → null (no highlight).
// `text`/`txt`/`plaintext`/`console` are explicitly no-highlight.
const LANG_ALIASES = {
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  python: 'python',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  markup: 'markup',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  docker: 'docker',
  dockerfile: 'docker',
  kt: 'kotlin',
  kotlin: 'kotlin',
  // Explicit no-highlight languages.
  text: null,
  txt: null,
  plaintext: null,
  console: null
};

// Max code length for Prism highlighting. Beyond this we fall back to plain
// escaped output — Prism's tokenizer is linear but the streaming path
// re-renders every 50ms/400 chars, so huge blocks must not stall the UI.
const MAX_HIGHLIGHT_LENGTH = 20000;

// Returns {id, html} when the fence language maps to a loaded Prism grammar,
// otherwise null (caller falls back to plain escaped output). Prism escapes
// the code internally — never pre-escape before calling highlight().
function highlightCode(lang, code) {
  if (code.length > MAX_HIGHLIGHT_LENGTH) {
    return null;
  }
  const id = LANG_ALIASES[String(lang).toLowerCase()];
  if (!id) {
    return null;
  }
  const grammar = Prism.languages[id];
  if (!grammar) {
    return null;
  }
  try {
    return { id: id, html: Prism.highlight(code, grammar, id) };
  } catch {
    // Prism must never crash rendering — fall back to plain escaped output.
    return null;
  }
}

export function renderMarkdown(src) {
  if (!src) {
    return '';
  }

  // 1. Pull fenced code blocks out of the line pipeline. PUA-char tokens
  // (U+E000/U+E001) can't appear in real text and are safe in regexes.
  const blocks = [];
  const escaped = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, function (match, lang, code) {
    void match;
    const index = blocks.length;
    const token = '\uE000' + index + '\uE001';
    blocks.push({ lang: lang.trim(), code: code.replace(/\n$/, '') });
    return token;
  });

  // 2. Escape everything, then apply inline rules to the escaped text.
  // Inline code spans are tokenized FIRST so markdown inside backticks
  // (`**x**`, `[x](y)`) stays literal code instead of being reformatted by
  // the bold/italic/link rules. The NUL-sentinel tokens can't collide with
  // typed content. The sentinels are restored AFTER the block pass (step 4)
  // so pipes inside inline code can't be split by table row parsing.
  let html = escapeHtml(escaped);
  const inlineCodes = [];
  let inlineCodeIndex = 0;
  html = html.replace(/`([^`\n]+)`/g, function (match, code) {
    void match;
    // Pick an unused sentinel index, guarding against stray NUL chars in
    // the source text (escapeHtml passes them through untouched).
    let index = inlineCodeIndex;
    while (html.indexOf('\u0000') !== -1 && html.indexOf('\u0000INLINE' + index + '\u0000') !== -1) {
      index += 1;
    }
    inlineCodes[index] = code;
    inlineCodeIndex = index + 1;
    return '\u0000INLINE' + index + '\u0000';
  });
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
    void match;
    // Only whitelisted URL schemes become hrefs; dangerous schemes render
    // as plain text so they can never be invoked from the rendered page.
    const href = safeLinkHref(url);
    return href === null ? match : '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });

  // 3. Block-level pass, line by line.
  let out = '';
  // Open list stack. Levels are strictly increasing; each deeper list lives
  // inside the previous list's still-open <li>.
  /** @type {{tag: string, level: number}[]} */
  const listStack = [];

  function closeList() {
    while (listStack.length) {
      const top = listStack[listStack.length - 1];
      out += '</li></' + top.tag + '>';
      listStack.pop();
    }
  }

  // Close lists deeper than `level`; if the list at `level` exists with a
  // different marker type, close it too. Returns true when an item at
  // `level` can join the existing list (same tag), false when a new list
  // must be opened.
  function closeListTo(level, tag) {
    while (listStack.length && listStack[listStack.length - 1].level > level) {
      const top = listStack[listStack.length - 1];
      out += '</li></' + top.tag + '>';
      listStack.pop();
    }
    if (listStack.length && listStack[listStack.length - 1].level === level) {
      const top = listStack[listStack.length - 1];
      if (top.tag === tag) {
        out += '</li>';
        return true;
      }
      out += '</li></' + top.tag + '>';
      listStack.pop();
    }
    return false;
  }

  // Indent width → nesting level. 0 spaces = level 0; 1-3 spaces = level 1;
  // 4-6 = level 2; ... Tolerant of 2/3/4-space indents.
  function indentLevel(spaces) {
    if (spaces === 0) {
      return 0;
    }
    return Math.ceil(spaces / 3);
  }

  function emitListItem(level, tag, content) {
    if (!closeListTo(level, tag)) {
      out += '<' + tag + '>';
      listStack.push({ tag: tag, level: level });
    }
    // The `</li>` is emitted by closeListTo()/closeList() when the next item
    // arrives or the list closes — never here, or items would close twice.
    const task = content.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      const checked = task[1] !== ' ' ? ' checked' : '';
      out += '<li class="task"><input type="checkbox" disabled' + checked + '> ' + task[2];
    } else {
      out += '<li>' + content;
    }
  }

  // Split a table row on `|`, trimming cells and stripping optional leading/
  // trailing pipes. Cell content is already escaped + inline-formatted; the
  // NUL sentinels for inline code contain no `|`, so pipes inside inline
  // code survive the split untouched.
  function splitTableRow(row) {
    let s = row.trim();
    if (s.charAt(0) === '|') {
      s = s.slice(1);
    }
    if (s.charAt(s.length - 1) === '|') {
      s = s.slice(0, -1);
    }
    return s.split('|').map(function (cell) {
      return cell.trim();
    });
  }

  // A delimiter row is `|---|`, `|:---:|`, `|---|---|`, ... — every cell must
  // contain at least one dash (colons optional; alignment is ignored).
  function isDelimiterRow(row) {
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(row)) {
      return false;
    }
    const cells = splitTableRow(row);
    return cells.length > 0 && cells.every(function (cell) {
      return /^:?-+:?$/.test(cell);
    });
  }

  // A table starts at a header row containing `|` whose next line is a valid
  // delimiter row with the same column count. List items, headings, and
  // blockquote lines are block elements — never table headers.
  function isTableStart(line, next) {
    if (line.indexOf('|') === -1 || line.indexOf('&gt;') === 0) {
      return false;
    }
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line) || /^#{1,4}\s/.test(line)) {
      return false;
    }
    if (next === undefined || !isDelimiterRow(next)) {
      return false;
    }
    const headerCells = splitTableRow(line);
    const delimCells = splitTableRow(next);
    return headerCells.length > 0 && delimCells.length === headerCells.length;
  }

  const lines = html.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m;

    // Code block placeholder line — emit raw, restored later.
    if (/^\uE000\d+\uE001$/.test(line)) {
      closeList();
      out += line;
      continue;
    }

    // GFM pipe table: header row + delimiter row + body rows until blank.
    if (isTableStart(line, lines[i + 1])) {
      closeList();
      const headerCells = splitTableRow(line);
      out += '<table><thead><tr>';
      for (const cell of headerCells) {
        out += '<th>' + cell + '</th>';
      }
      out += '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length) {
        const row = lines[i];
        if (row.trim() === '' || row.indexOf('|') === -1 || /^\uE000\d+\uE001$/.test(row)) {
          break;
        }
        const cells = splitTableRow(row);
        out += '<tr>';
        for (let c = 0; c < headerCells.length; c += 1) {
          out += '<td>' + (cells[c] === undefined ? '' : cells[c]) + '</td>';
        }
        out += '</tr>';
        i += 1;
      }
      out += '</tbody></table>';
      i -= 1;
      continue;
    }

    // Headings.
    m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      closeList();
      const level = m[1].length;
      out += '<h' + level + '>' + m[2] + '</h' + level + '>';
      continue;
    }

    // Blockquote: consecutive `>` lines merge into one <blockquote>, one
    // <p> per line (strip the `>` + optional single space).
    if (/^&gt; ?/.test(line)) {
      closeList();
      out += '<blockquote>';
      while (i < lines.length && /^&gt; ?/.test(lines[i])) {
        out += '<p>' + lines[i].replace(/^&gt; ?/, '') + '</p>';
        i += 1;
      }
      out += '</blockquote>';
      i -= 1;
      continue;
    }

    // Lists (indent-aware, nested; task items).
    m = line.match(/^(\s*)([-*])\s+(.*)$/);
    if (m) {
      emitListItem(indentLevel(m[1].length), 'ul', m[3]);
      continue;
    }
    m = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (m) {
      emitListItem(indentLevel(m[1].length), 'ol', m[2]);
      continue;
    }

    closeList();

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out += '<hr>';
      continue;
    }

    // Paragraph (blank lines collapse).
    if (line.trim() !== '') {
      out += '<p>' + line + '</p>';
    }
  }
  closeList();

  // 4. Restore inline code spans. Deferred to after the block pass so pipes
  // inside inline code can't be split by table row parsing — the NUL
  // sentinels contain no `|`. Built via new RegExp: NUL control chars aren't
  // allowed in regex literals, but are legal in the string pattern.
  let result = out.replace(new RegExp('\u0000INLINE(\\d+)\u0000', 'g'), function (token, indexStr) {
    void token;
    const code = inlineCodes[Number(indexStr)];
    return code === undefined ? '' : '<code>' + code + '</code>';
  });

  // 5. Restore code blocks. Known language → Prism-highlighted (Prism escapes
  // internally); unknown/absent/oversized → plain escaped output as before.
  // The .code-head row is always present so the copy button exists even for
  // language-less blocks; .code-lang is a span inside it, only when a lang
  // was given.
  return result.replace(/\uE000(\d+)\uE001/g, function (token, indexStr) {
    void token;
    const block = blocks[Number(indexStr)];
    if (!block) {
      return '';
    }
    const langSpan = block.lang ? '<span class="code-lang">' + escapeHtml(block.lang) + '</span>' : '';
    const head = '<div class="code-head">' + langSpan + '<button type="button" class="code-copy" title="Copy code" aria-label="Copy code">Copy</button></div>';
    const highlighted = highlightCode(block.lang, block.code);
    if (highlighted) {
      return '<div class="code-block">' + head + '<pre><code class="language-' + highlighted.id + '">' + highlighted.html + '</code></pre></div>';
    }
    return '<div class="code-block">' + head + '<pre><code>' + escapeHtml(block.code) + '</code></pre></div>';
  });
}