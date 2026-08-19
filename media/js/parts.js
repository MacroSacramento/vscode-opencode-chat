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

// Field priority for turning a tool's `state.input` into a short one-liner
// shown in the chip header area. The runtime tool parts carry no top-level
// `title`, so this is what the user sees at a glance.
const TOOL_SUMMARY_FIELDS = ['command', 'cmd', 'query', 'pattern', 'prompt', 'text', 'url', 'path', 'filePath', 'message', 'description'];

function summarizeToolInput(input) {
  if (input === undefined || input === null) {
    return '';
  }
  if (typeof input === 'string') {
    return input;
  }
  if (typeof input !== 'object') {
    return String(input);
  }
  // grep-style: pattern + path together → "pattern · path".
  if (typeof input.pattern === 'string' && input.pattern && typeof input.path === 'string' && input.path) {
    return input.pattern + ' \u00B7 ' + input.path;
  }
  for (let i = 0; i < TOOL_SUMMARY_FIELDS.length; i += 1) {
    const val = input[TOOL_SUMMARY_FIELDS[i]];
    if (typeof val === 'string' && val) {
      return val;
    }
  }
  // Fallback: compact single-line JSON, truncated.
  let text;
  try {
    text = JSON.stringify(input);
  } catch (e) {
    text = String(input);
  }
  if (text.length > 200) {
    text = text.slice(0, 200) + '\u2026';
  }
  return text;
}

export function buildToolChip(part) {
  const stateLabel = part.state && part.state.status ? part.state.status : 'pending';
  const chip = document.createElement('div');
  chip.className = 'tool-chip';
  chip.dataset.state = stateLabel;

  const head = document.createElement('button');
  head.className = 'tool-chip-head';
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');

  const glyph = toolGlyph(stateLabel);
  const glyphEl = document.createElement('span');
  glyphEl.className = 'tool-glyph' + (glyph.spin ? ' spin' : '');
  glyphEl.textContent = glyph.text;

  const name = document.createElement('span');
  name.className = 'tool-name';
  const tool = String(part.tool || 'tool').trim();
  // Title lives on the state object, not the part (SDK ToolPart shape).
  const title = part.state && part.state.title ? String(part.state.title).trim() : '';
  name.textContent = title && title !== tool ? tool + ' \u00B7 ' + title : tool;

  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.textContent = '\u25B8'; // ▸

  head.appendChild(glyphEl);
  head.appendChild(name);
  head.appendChild(chevron);
  chip.appendChild(head);

  // Always-visible one-line summary of the tool call (e.g. the bash command),
  // so the user sees what the tool did without expanding. textContent only.
  const summary = summarizeToolInput(part.state && part.state.input);
  if (summary) {
    const summaryEl = document.createElement('div');
    summaryEl.className = 'tool-summary';
    summaryEl.textContent = summary;
    summaryEl.title = summary;
    chip.appendChild(summaryEl);
  }

  if (part.state && part.state.error) {
    chip.title = part.state.error;
  }

  const detail = document.createElement('div');
  detail.className = 'tool-detail';
  detail.hidden = true;

  // Input: pretty-printed JSON, textContent only (never innerHTML).
  const input = part.state && part.state.input;
  if (input !== undefined && input !== null) {
    let inputText;
    if (typeof input === 'object') {
      try {
        inputText = JSON.stringify(input, null, 2);
      } catch (e) {
        inputText = String(input);
      }
    } else {
      inputText = String(input);
    }
    if (inputText) {
      detail.appendChild(buildToolSection('Input', 'tool-input', inputText));
    }
  }

  // Output: only meaningful when the tool completed.
  if (stateLabel === 'completed') {
    const output = part.state && typeof part.state.output === 'string' ? part.state.output : '';
    if (output) {
      const MAX_OUTPUT = 2000;
      const shown = output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + '\n\u2026 (truncated)' : output;
      detail.appendChild(buildToolSection('Output', 'tool-output', shown));
    }
  }

  // Error: surfaced when the tool failed.
  if (stateLabel === 'error') {
    const err = part.state && part.state.error;
    if (err) {
      detail.appendChild(buildToolSection('Error', 'tool-error', String(err)));
    }
  }

  if (detail.childNodes.length > 0) {
    chip.appendChild(detail);
    head.addEventListener('click', function () {
      const open = !detail.hidden;
      detail.hidden = open;
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
  } else {
    // Nothing to show: hide the chevron so the chip reads as inert.
    chevron.hidden = true;
  }
  return chip;
}

function buildToolSection(label, className, text) {
  const wrap = document.createElement('div');
  const labelEl = document.createElement('div');
  labelEl.className = 'tool-section-label';
  labelEl.textContent = label;
  const pre = document.createElement('pre');
  pre.className = className;
  pre.textContent = text;
  wrap.appendChild(labelEl);
  wrap.appendChild(pre);
  return wrap;
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
      body.className = 'reasoning-body markdown';
      body.innerHTML = renderMarkdown(part.text || '');
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
