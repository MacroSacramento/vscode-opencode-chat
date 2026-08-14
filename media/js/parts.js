import { state } from './state.js';
import { formatMessageTime } from './utils.js';
import { renderMarkdown } from './markdown.js';

// ── Part rendering ───────────────────────────────────────────────────────

function toolGlyph(stateLabel) {
  switch (stateLabel) {
    case 'running':
      return { text: '\u27F3', spin: true };
    case 'completed':
      return { text: '\u2713', spin: false };
    case 'error':
      return { text: '\u2715', spin: false };
    case 'pending':
    default:
      return { text: '\u25E6', spin: false };
  }
}

export function buildToolChip(part) {
  const chip = document.createElement('span');
  chip.className = 'tool-chip';
  chip.dataset.state = part.state && part.state.status ? part.state.status : 'pending';
  const glyph = toolGlyph(chip.dataset.state);
  const glyphEl = document.createElement('span');
  glyphEl.className = 'tool-glyph' + (glyph.spin ? ' spin' : '');
  glyphEl.textContent = glyph.text;
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = (part.title || part.tool || 'tool').trim();
  if (part.title && part.title !== part.tool) {
    name.textContent = part.tool + ' · ' + part.title;
  }
  chip.appendChild(glyphEl);
  chip.appendChild(name);
  if (part.state && part.state.error) {
    chip.title = part.state.error;
  }
  return chip;
}

// Shared builder for quiet meta chips (step/patch/agent/subtask/retry/
// compaction). All part-provided strings go through textContent/title, so
// nothing can inject markup. Chips are inert: no handlers, no links.
export function buildMetaChip(label, extraClass, tooltip) {
  const chip = document.createElement('span');
  chip.className = 'part-chip' + (extraClass ? ' ' + extraClass : '');
  const text = document.createElement('span');
  text.className = 'part-chip-text';
  text.textContent = label;
  chip.appendChild(text);
  if (tooltip) {
    chip.title = tooltip;
  }
  return chip;
}

// Wraps one or more chips in the same flex row container tool chips use,
// so meta chips flow and wrap identically.
export function wrapChips() {
  const wrapper = document.createElement('div');
  wrapper.className = 'part-tools';
  for (let i = 0; i < arguments.length; i += 1) {
    wrapper.appendChild(arguments[i]);
  }
  return wrapper;
}

export function formatCount(value) {
  if (typeof value !== 'number' || !isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
}

// step-finish tooltip: cost + token usage summary, multi-line via \n.
export function buildStepSummary(part) {
  const bits = [];
  if (typeof part.cost === 'number' && isFinite(part.cost)) {
    bits.push('cost ' + part.cost.toFixed(4).replace(/\.?0+$/, ''));
  }
  const t = part.tokens;
  if (t && typeof t === 'object') {
    const io = [];
    if (typeof t.input === 'number') {
      io.push(formatCount(t.input) + ' in');
    }
    if (typeof t.output === 'number') {
      io.push(formatCount(t.output) + ' out');
    }
    if (typeof t.reasoning === 'number') {
      io.push(formatCount(t.reasoning) + ' reasoning');
    }
    if (io.length) {
      bits.push(io.join(' \u00B7 '));
    }
    const cache = t.cache;
    if (cache && typeof cache === 'object') {
      const cb = [];
      if (typeof cache.read === 'number') {
        cb.push(formatCount(cache.read) + ' read');
      }
      if (typeof cache.write === 'number') {
        cb.push(formatCount(cache.write) + ' write');
      }
      if (cb.length) {
        bits.push('cache ' + cb.join(' \u00B7 '));
      }
    }
  }
  return bits.join(' \u00B7 ');
}

export function renderPart(part) {
  if (!part || typeof part.type !== 'string') {
    return null;
  }
  switch (part.type) {
    case 'text': {
      if (part.synthetic || part.ignored) {
        return null;
      }
      const div = document.createElement('div');
      div.className = 'part-text';
      div.innerHTML = renderMarkdown(part.text || '');
      return div;
    }
    case 'reasoning': {
      const details = document.createElement('details');
      details.className = 'reasoning';
      if (state.showThinking) {
        details.open = true;
      }
      const summary = document.createElement('summary');
      summary.textContent = 'Reasoning';
      const body = document.createElement('div');
      body.className = 'reasoning-body';
      body.textContent = part.text || '';
      details.appendChild(summary);
      details.appendChild(body);
      return details;
    }
    case 'tool': {
      const wrapper = document.createElement('div');
      wrapper.className = 'part-tools';
      wrapper.appendChild(buildToolChip(part));
      return wrapper;
    }
    case 'file': {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.textContent = part.filename || 'file';
      chip.title = part.filename || part.url || '';
      // Image files also render the image itself (via part.url) below the
      // filename chip. Other mime types keep the plain chip.
      if (typeof part.mime === 'string' && part.mime.indexOf('image/') === 0 && part.url) {
        const wrap = document.createElement('div');
        wrap.className = 'file-image';
        const img = document.createElement('img');
        img.src = part.url;
        img.alt = part.filename || 'image';
        img.loading = 'lazy';
        img.draggable = false;
        wrap.appendChild(chip);
        wrap.appendChild(img);
        return wrap;
      }
      return chip;
    }
    case 'step-start': {
      // Thin divider + tiny "Step" label marking a step boundary.
      const div = document.createElement('div');
      div.className = 'part-step';
      const label = document.createElement('span');
      label.className = 'part-step-label';
      label.textContent = 'Step';
      div.appendChild(label);
      return div;
    }
    case 'step-finish': {
      const reason = typeof part.reason === 'string' && part.reason ? part.reason : '';
      const label = reason ? 'Step finished \u2014 ' + reason : 'Step finished';
      return wrapChips(buildMetaChip(label, 'step-finish-chip', buildStepSummary(part)));
    }
    case 'patch': {
      const files = Array.isArray(part.files) ? part.files : [];
      const n = files.length;
      const label = n + (n === 1 ? ' file' : ' files');
      return wrapChips(buildMetaChip(label, 'patch-chip', files.join(', ')));
    }
    case 'agent': {
      const name = String(part.name || 'agent');
      return wrapChips(buildMetaChip(name, 'agent-chip'));
    }
    case 'subtask': {
      const agent = String(part.agent || 'agent');
      const desc = typeof part.description === 'string' && part.description ? part.description : part.prompt;
      return wrapChips(buildMetaChip('Spawned ' + agent, 'subtask-chip', desc));
    }
    case 'retry': {
      const attempt = typeof part.attempt === 'number' ? part.attempt : 0;
      const label = attempt > 0 ? 'Retry #' + attempt : 'Retry';
      const err = part.error ? part.error.message || part.error : '';
      return wrapChips(buildMetaChip(label, 'retry-chip', String(err)));
    }
    case 'compaction': {
      return wrapChips(buildMetaChip('Context compacted', 'compact-chip'));
    }
    default:
      return null;
  }
}

export function appendParts(container, role, parts) {
  if (role === 'user') {
    // User turns are plain text (escaped via textContent, no markdown).
    const texts = parts.filter(function (p) {
      return p.type === 'text' && !p.synthetic && !p.ignored;
    });
    const div = document.createElement('div');
    div.className = 'part-text';
    div.textContent = texts.map(function (p) {
      return p.text || '';
    }).join('\n');
    container.appendChild(div);
    return;
  }
  const md = document.createElement('div');
  md.className = 'markdown';
  parts.forEach(function (part) {
    const node = renderPart(part);
    if (node) {
      md.appendChild(node);
    }
  });
  container.appendChild(md);
}

function buildStreamContainer() {
  const container = document.createElement('div');
  container.className = 'part-stream';
  container.dataset.part = 'stream';
  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.textContent = 'Thinking\u2026';
  container.appendChild(thinking);
  return container;
}

function buildTyping() {
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.hidden = true;
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'typing-dot';
    typing.appendChild(dot);
  }
  return typing;
}

export function buildMessageEl(message) {
  const el = document.createElement('div');
  el.className = 'message';
  el.dataset.role = message.role || 'assistant';
  el.dataset.messageId = message.id || '';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const roleLabel = document.createElement('span');
  roleLabel.className = 'message-role';
  roleLabel.textContent = message.role === 'user' ? 'You' : 'OpenCode';
  meta.appendChild(roleLabel);
  if (message.role === 'user' && message.time) {
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatMessageTime(message.time);
    meta.appendChild(time);
  }
  el.appendChild(meta);

  const content = document.createElement('div');
  content.className = 'message-content';
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (message.role === 'assistant' && parts.length === 0) {
    content.appendChild(buildStreamContainer());
  } else {
    appendParts(content, message.role, parts);
  }
  el.appendChild(content);

  if (message.role === 'assistant') {
    el.appendChild(buildTyping());
  }
  return el;
}
