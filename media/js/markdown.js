// ── Markdown renderer ────────────────────────────────────────────────────
// Dependency-free subset: headings, bold/italic, inline + fenced code,
// unordered/ordered lists, links, blockquotes, hr. All source text is
// escaped before anything else so user/assistant content can never inject
// markup.

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
  // typed content.
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
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
    void match;
    // Only whitelisted URL schemes become hrefs; dangerous schemes render
    // as plain text so they can never be invoked from the rendered page.
    const href = safeLinkHref(url);
    return href === null ? match : '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  // Restore inline code spans (already escaped — never reformatted).
  // Built via new RegExp: NUL control chars aren't allowed in regex
  // literals, but are legal in the string pattern.
  html = html.replace(new RegExp('\u0000INLINE(\\d+)\u0000', 'g'), function (token, indexStr) {
    void token;
    const code = inlineCodes[Number(indexStr)];
    return code === undefined ? '' : '<code>' + code + '</code>';
  });

  // 3. Block-level pass, line by line.
  let out = '';
  let listType = null; // 'ul' | 'ol'
  let inQuote = false;

  function closeList() {
    if (listType === 'ul') {
      out += '</ul>';
    } else if (listType === 'ol') {
      out += '</ol>';
    }
    listType = null;
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

    // Headings.
    m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      closeList();
      const level = m[1].length;
      out += '<h' + level + '>' + m[2] + '</h' + level + '>';
      continue;
    }

    // Blockquote.
    if (line.indexOf('&gt; ') === 0) {
      if (!inQuote) {
        inQuote = true;
        out += '<blockquote>';
      }
      out += '<p>' + line.slice(5) + '</p>';
      continue;
    }
    if (inQuote) {
      out += '</blockquote>';
      inQuote = false;
    }

    // Lists.
    m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      if (listType !== 'ul') {
        closeList();
        out += '<ul>';
        listType = 'ul';
      }
      out += '<li>' + m[1] + '</li>';
      continue;
    }
    m = line.match(/^\s*\d+\.\s+(.*)$/);
    if (m) {
      if (listType !== 'ol') {
        closeList();
        out += '<ol>';
        listType = 'ol';
      }
      out += '<li>' + m[1] + '</li>';
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
  if (inQuote) {
    out += '</blockquote>';
  }

  // 4. Restore code blocks.
  return out.replace(/\uE000(\d+)\uE001/g, function (token, indexStr) {
    void token;
    const block = blocks[Number(indexStr)];
    if (!block) {
      return '';
    }
    const header = block.lang ? '<div class="code-lang">' + escapeHtml(block.lang) + '</div>' : '';
    return '<div class="code-block">' + header + '<pre><code>' + escapeHtml(block.code) + '</code></pre></div>';
  });
}
