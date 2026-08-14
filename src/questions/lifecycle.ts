import { getClient } from '../opencodeClient';
import type { ProviderContext, QuestionEntry } from '../webview/types';

/**
 * Flattens raw SDK QuestionInfo/QuestionV2Info objects (from SSE
 * `question.asked` / `question.v2.asked`) into webview-safe projections.
 * Malformed entries (missing question text) are dropped; option-less
 * open-ended questions are kept with an empty options array so the webview
 * can still render a free-text input.
 */
function toQuestionEntries(questions: unknown): QuestionEntry[] {
  if (!Array.isArray(questions)) {
    return [];
  }
  const entries: QuestionEntry[] = [];
  for (const q of questions) {
    if (q === null || typeof q !== 'object') {
      continue;
    }
    const record = q as Record<string, unknown>;
    const header = typeof record.header === 'string' ? record.header : '';
    const question = typeof record.question === 'string' ? record.question : '';
    const options = Array.isArray(record.options)
      ? record.options
          .filter((o): o is { label: string; description: string } => {
            if (o === null || typeof o !== 'object') {
              return false;
            }
            const orec = o as Record<string, unknown>;
            return typeof orec.label === 'string' && typeof orec.description === 'string';
          })
          .map((o) => ({ label: o.label, description: o.description }))
      : [];
    if (question === '') {
      continue;
    }
    entries.push({
      header: header === '' ? 'Question' : header,
      question,
      options,
      ...(record.multiple === true ? { multiple: true } : {}),
      ...(record.custom === true ? { custom: true } : {}),
    });
  }
  return entries;
}

/**
 * Owns the question and permission lifecycle: the per-session pending-question
 * map (used to auto-reject stale questions when a new prompt is sent — an
 * unanswered question wedges the session server-side, so a fresh prompt must
 * clear it first), the SSE event cases that surface questions/permissions to
 * the webview, and the webview reply handlers that route answers back.
 */
export class QuestionLifecycle {
  private readonly pendingQuestions = new Map<string, { id: string; version: 'v1' | 'v2' }>();

  constructor(private readonly ctx: ProviderContext) {}

  /**
   * Handles the SSE event cases owned by this module: permission.asked,
   * permission.v2.asked, permission.replied/v2, question.asked/v2 and
   * question.replied/v2/rejected/v2. Pending questions are tracked for every
   * session regardless of active status so a later prompt can auto-reject
   * them; posts to the webview are gated on the active session.
   */
  handleEvent(type: string, properties: any): void {
    const p = properties;
    // Tolerate both `{ sessionID }` (contract) and `{ data: { sessionID } }`
    // (raw SDK event) shapes.
    const sessionID = p.sessionID ?? p.data?.sessionID;

    switch (type) {
      case 'permission.asked': {
        const id = typeof p.id === 'string' ? p.id : undefined;
        const permission = typeof p.permission === 'string' ? p.permission : undefined;
        const patterns = Array.isArray(p.patterns) ? p.patterns.filter((x: unknown): x is string => typeof x === 'string') : [];
        if (sessionID === undefined || sessionID !== this.ctx.getActiveSessionId() || id === undefined || permission === undefined) {
          break;
        }
        this.ctx.post({ type: 'permission', request: { version: 'v1', id, sessionID, permission, patterns } });
        break;
      }
      case 'permission.v2.asked': {
        const id = typeof p.id === 'string' ? p.id : undefined;
        const action = typeof p.action === 'string' ? p.action : undefined;
        const resources = Array.isArray(p.resources) ? p.resources.filter((x: unknown): x is string => typeof x === 'string') : [];
        if (sessionID === undefined || sessionID !== this.ctx.getActiveSessionId() || id === undefined || action === undefined) {
          break;
        }
        this.ctx.post({ type: 'permission', request: { version: 'v2', id, sessionID, action, resources } });
        break;
      }
      case 'permission.replied':
      case 'permission.v2.replied': {
        const requestID = typeof p.requestID === 'string' ? p.requestID : undefined;
        if (sessionID === undefined || sessionID !== this.ctx.getActiveSessionId() || requestID === undefined) {
          break;
        }
        this.ctx.post({ type: 'permissionResolved', sessionID, requestID });
        break;
      }
      case 'question.asked':
      case 'question.v2.asked': {
        const id = typeof p.id === 'string' ? p.id : undefined;
        const rawQuestions = p.questions ?? p.data?.questions;
        if (sessionID === undefined || id === undefined || !Array.isArray(rawQuestions)) {
          break;
        }
        // Track the pending question regardless of active-session status so a
        // new prompt can auto-reject it (prevents session wedging).
        this.pendingQuestions.set(sessionID, { id, version: type === 'question.v2.asked' ? 'v2' : 'v1' });
        if (sessionID !== this.ctx.getActiveSessionId()) {
          break;
        }
        const questions = toQuestionEntries(rawQuestions);
        if (questions.length === 0) {
          break;
        }
        this.ctx.post({
          type: 'question',
          request: {
            version: type === 'question.v2.asked' ? 'v2' : 'v1',
            id,
            sessionID,
            questions,
          },
        });
        break;
      }
      case 'question.replied':
      case 'question.v2.replied':
      case 'question.rejected':
      case 'question.v2.rejected': {
        const requestID = typeof p.requestID === 'string' ? p.requestID : undefined;
        if (sessionID === undefined || requestID === undefined) {
          break;
        }
        const pending = this.pendingQuestions.get(sessionID);
        if (pending !== undefined && pending.id === requestID) {
          this.pendingQuestions.delete(sessionID);
        }
        if (sessionID !== this.ctx.getActiveSessionId()) {
          break;
        }
        this.ctx.post({ type: 'questionResolved', sessionID, requestID });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Rejects any unanswered question for a session before a new prompt is sent,
   * so a fresh prompt never queues behind a wedged question.
   */
  async onPrompt(sessionId: string): Promise<void> {
    const pending = this.pendingQuestions.get(sessionId);
    if (pending !== undefined) {
      this.pendingQuestions.delete(sessionId);
      try {
        if (pending.version === 'v1') {
          await getClient().question.reject({ requestID: pending.id });
        } else {
          await getClient().v2.session.question.reject({ sessionID: sessionId, requestID: pending.id });
        }
      } catch {
        // Best-effort: the stale question may already be gone server-side.
      }
    }
  }

  /** Handles a `permissionReply` webview message. */
  async handlePermissionReply(message: Record<string, unknown>): Promise<void> {
    const requestID = typeof message.requestID === 'string' ? message.requestID : undefined;
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const reply = message.reply;
    const version = message.version;
    if (requestID === undefined || (reply !== 'once' && reply !== 'always' && reply !== 'reject') || (version !== 'v1' && version !== 'v2')) {
      return;
    }
    if (!this.ctx.isConnected()) {
      this.ctx.post({ type: 'error', message: 'Not connected to the OpenCode server.' });
      return;
    }
    try {
      if (version === 'v1') {
        await getClient().permission.reply({ requestID, reply });
      } else {
        // v2 permissions are session-scoped; Permission3 (client.v2.permission)
        // exposes no reply method, so the session-scoped Permission2 endpoint
        // (client.v2.session.permission.reply) is the matching reply for v2.
        if (sessionId === undefined) {
          return;
        }
        await getClient().v2.session.permission.reply({ sessionID: sessionId, requestID, reply });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to reply to permission: ${detail}` });
    }
  }

  /** Handles a `questionReply` webview message. */
  async handleQuestionReply(message: Record<string, unknown>): Promise<void> {
    const requestID = typeof message.requestID === 'string' ? message.requestID : undefined;
    const sessionId = typeof message.sessionID === 'string' ? message.sessionID : undefined;
    const version = message.version;
    const reject = message.reject === true;
    // Answers is a per-question array of selected labels (option labels,
    // plus any custom free-text value appended for custom questions).
    const answers = Array.isArray(message.answers)
      ? message.answers.filter(
          (a): a is Array<string> => Array.isArray(a) && a.every((x) => typeof x === 'string'),
        )
      : [];
    if (requestID === undefined || (version !== 'v1' && version !== 'v2')) {
      return;
    }
    if (!this.ctx.isConnected()) {
      this.ctx.post({ type: 'error', message: 'Not connected to the OpenCode server.' });
      return;
    }
    try {
      if (reject) {
        if (version === 'v1') {
          await getClient().question.reject({ requestID });
        } else {
          if (sessionId === undefined) {
            return;
          }
          await getClient().v2.session.question.reject({ sessionID: sessionId, requestID });
        }
      } else if (version === 'v1') {
        await getClient().question.reply({ requestID, answers });
      } else {
        if (sessionId === undefined) {
          return;
        }
        await getClient().v2.session.question.reply({
          sessionID: sessionId,
          requestID,
          questionV2Reply: { answers },
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to answer question: ${detail}` });
    }
  }
}
