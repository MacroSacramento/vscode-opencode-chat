import { state } from './state.js';
import { post } from './utils.js';

// ── Permission prompts ──────────────────────────────────────────────────

function buildPermissionButton(label, reply, className) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', function () {
    replyPermission(reply);
  });
  return btn;
}

export function showPermissionCard(request) {
  state.pendingPermission = request;
  const card = state.permissionCard;
  card.textContent = '';

  const head = document.createElement('div');
  head.className = 'permission-head';
  head.textContent = 'Permission required';

  const text = document.createElement('div');
  text.className = 'permission-text';
  const strong = document.createElement('span');
  strong.className = 'permission-strong';
  if (request.version === 'v1') {
    strong.textContent = [request.permission].concat(request.patterns || []).filter(Boolean).join(' ');
  } else {
    strong.textContent = [request.action].concat(request.resources || []).filter(Boolean).join(' ');
  }
  text.appendChild(document.createTextNode('OpenCode wants to: '));
  text.appendChild(strong);

  const actions = document.createElement('div');
  actions.className = 'permission-actions';
  actions.appendChild(buildPermissionButton('Allow', 'once', 'permission-btn allow'));
  actions.appendChild(buildPermissionButton('Always allow', 'always', 'permission-btn always'));
  actions.appendChild(buildPermissionButton('Deny', 'reject', 'permission-btn deny'));

  card.appendChild(head);
  card.appendChild(text);
  card.appendChild(actions);
  card.hidden = false;
}

export function hidePermissionCard() {
  state.pendingPermission = null;
  state.permissionCard.hidden = true;
}

export function replyPermission(reply) {
  const req = state.pendingPermission;
  if (!req) {
    return;
  }
  post({
    type: 'permissionReply',
    requestID: req.id,
    reply: reply,
    version: req.version,
    sessionId: req.sessionID,
  });
  // Optimistic: the server's permission.replied event (or a failed reply
  // surfacing as a toast) catches the fall-through.
  hidePermissionCard();
}

// ── Question prompts ────────────────────────────────────────────────────

// Selection state lives in the DOM: `.question-option.selected` rows carry
// the picked labels, `.question-custom` inputs the free-text answers. This
// keeps the card self-contained and lets a re-render rebuild cleanly.

const QUESTION_MARKS = { on: '\u25C9', off: '\u25EF' }; // ◉ / ◯ (radio)
const QUESTION_CHECKS = { on: '\u2611', off: '\u2610' }; // ☑ / ☐ (checkbox)

export function buildQuestionOption(q, opt) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'question-option';
  row.dataset.label = opt.label;
  row.setAttribute('role', q.multiple ? 'checkbox' : 'radio');
  row.setAttribute('aria-checked', 'false');

  const mark = document.createElement('span');
  mark.className = 'question-option-mark';
  mark.textContent = q.multiple ? QUESTION_CHECKS.off : QUESTION_MARKS.off;
  row.appendChild(mark);

  const text = document.createElement('span');
  text.className = 'question-option-text';
  const label = document.createElement('span');
  label.className = 'question-option-label';
  label.textContent = opt.label;
  const desc = document.createElement('span');
  desc.className = 'question-option-desc';
  desc.textContent = opt.description || '';
  text.appendChild(label);
  text.appendChild(desc);
  row.appendChild(text);

  row.addEventListener('click', function () {
    toggleQuestionOption(row, q.multiple === true);
  });
  return row;
}

export function toggleQuestionOption(row, multiple) {
  const options = row.parentElement;
  if (multiple) {
    const selected = row.classList.toggle('selected');
    row.setAttribute('aria-checked', selected ? 'true' : 'false');
    row.querySelector('.question-option-mark').textContent = selected ? QUESTION_CHECKS.on : QUESTION_CHECKS.off;
  } else {
    // Radio semantics: picking an option clears the rest of the question.
    options.querySelectorAll('.question-option.selected').forEach(function (other) {
      other.classList.remove('selected');
      other.setAttribute('aria-checked', 'false');
      other.querySelector('.question-option-mark').textContent = QUESTION_MARKS.off;
    });
    row.classList.add('selected');
    row.setAttribute('aria-checked', 'true');
    row.querySelector('.question-option-mark').textContent = QUESTION_MARKS.on;
  }
  updateQuestionSendState();
}

export function updateQuestionSendState() {
  const card = state.questionCard;
  if (card.hidden || !state.pendingQuestion) {
    return;
  }
  const send = card.querySelector('.question-btn.send');
  if (!send) {
    return;
  }
  const blocks = card.querySelectorAll('.question-block');
  let complete = blocks.length > 0;
  blocks.forEach(function (block) {
    const q = state.pendingQuestion.questions[Number(block.dataset.qIndex)];
    if (!q) {
      complete = false;
      return;
    }
    const hasOption = block.querySelector('.question-option.selected') !== null;
    const custom = block.querySelector('.question-custom');
    const customFilled = custom !== null && custom.value.trim() !== '';
    if (!hasOption && !customFilled) {
      complete = false;
    }
  });
  send.disabled = !complete;
}

export function showQuestionCard(request) {
  state.pendingQuestion = request;
  const card = state.questionCard;
  card.textContent = '';

  const head = document.createElement('div');
  head.className = 'question-head';
  head.textContent = 'OpenCode asks';
  card.appendChild(head);

  (request.questions || []).forEach(function (q, qIndex) {
    const block = document.createElement('div');
    block.className = 'question-block';
    block.dataset.qIndex = String(qIndex);

    const title = document.createElement('div');
    title.className = 'question-title';
    title.textContent = q.question;
    block.appendChild(title);

    if (q.header) {
      const header = document.createElement('div');
      header.className = 'question-header';
      header.textContent = q.header;
      block.appendChild(header);
    }

    if ((q.options || []).length > 0) {
      const options = document.createElement('div');
      options.className = 'question-options';
      (q.options || []).forEach(function (opt) {
        options.appendChild(buildQuestionOption(q, opt));
      });
      block.appendChild(options);
    }

    // Always render the free-text input: the server accepts a typed answer
    // for ANY question (verified), and models don't reliably set the
    // `custom` flag even when they invite a typed answer (e.g. an option
    // labeled "I'll type my own"). A missing box left users stuck.
    {
      const input = document.createElement('input');
      input.className = 'question-custom';
      input.type = 'text';
      input.placeholder = 'Or type your own answer\u2026';
      input.addEventListener('input', updateQuestionSendState);
      block.appendChild(input);
    }

    card.appendChild(block);
  });

  const footer = document.createElement('div');
  footer.className = 'question-footer';
  const dismiss = document.createElement('button');
  dismiss.className = 'question-btn dismiss';
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', dismissQuestion);
  const send = document.createElement('button');
  send.className = 'question-btn send';
  send.type = 'button';
  send.textContent = 'Send';
  send.disabled = true;
  send.addEventListener('click', sendQuestion);
  footer.appendChild(dismiss);
  footer.appendChild(send);
  card.appendChild(footer);

  card.hidden = false;
  card.focus();
  updateQuestionSendState();
}

export function hideQuestionCard() {
  state.pendingQuestion = null;
  state.questionCard.hidden = true;
  state.questionCard.textContent = '';
}

export function sendQuestion() {
  const req = state.pendingQuestion;
  if (!req) {
    return;
  }
  const card = state.questionCard;
  const answers = [];
  const blocks = card.querySelectorAll('.question-block');
  blocks.forEach(function (block) {
    const q = req.questions[Number(block.dataset.qIndex)];
    const picked = [];
    block.querySelectorAll('.question-option.selected').forEach(function (opt) {
      picked.push(opt.dataset.label);
    });
    // Free-text rides along when non-empty (appended to the labels). The
    // input exists for custom questions and for option-less open-ended
    // questions, so gate on the input, not on the custom flag.
    if (q) {
      const custom = block.querySelector('.question-custom');
      if (custom !== null && custom.value.trim() !== '') {
        picked.push(custom.value.trim());
      }
    }
    answers.push(picked);
  });
  if (answers.length !== req.questions.length) {
    return;
  }
  post({
    type: 'questionReply',
    requestID: req.id,
    sessionID: req.sessionID,
    version: req.version,
    answers: answers,
  });
  // Optimistic: the server's question.replied event (or a failed reply
  // surfacing as a toast) catches the fall-through.
  hideQuestionCard();
}

export function dismissQuestion() {
  const req = state.pendingQuestion;
  if (!req) {
    return;
  }
  post({
    type: 'questionReply',
    requestID: req.id,
    sessionID: req.sessionID,
    version: req.version,
    answers: [],
    reject: true,
  });
  hideQuestionCard();
}
