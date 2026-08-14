import { getClient, isConnected } from '../opencodeClient';
import { toHistoryMessage } from '../webview/types';
import type { ProviderContext } from '../webview/types';

/**
 * Owns conversation-history loading plus the per-session last-assistant-message
 * tracking used by undo/revert. The map is kept in sync from history loads and
 * `message.updated` SSE events, and cleared when the tracked message goes stale.
 */
export class HistoryService {
  private readonly lastAssistantMessageId = new Map<string, string>();

  constructor(private readonly ctx: ProviderContext) {}

  async loadHistory(sessionId: string): Promise<void> {
    if (!isConnected()) {
      return;
    }
    try {
      const res = await getClient().session.messages({ sessionID: sessionId });
      const list = res.data ?? [];
      // Track the last assistant message so undo can revert the most recent turn.
      // If none exists, drop any stale id so a dead message is never reused.
      let lastAssistantId: string | undefined;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].info.role === 'assistant') {
          lastAssistantId = list[i].info.id;
          break;
        }
      }
      if (lastAssistantId !== undefined) {
        this.lastAssistantMessageId.set(sessionId, lastAssistantId);
      } else {
        this.lastAssistantMessageId.delete(sessionId);
      }
      const messages = list.map((m) => toHistoryMessage(m.info, m.parts));
      this.ctx.post({ type: 'history', sessionId, messages });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to load conversation: ${detail}` });
    }
  }

  /** Records an assistant message id from a `message.updated` SSE event. */
  trackAssistantMessage(sessionID: string, id: string): void {
    this.lastAssistantMessageId.set(sessionID, id);
  }

  /**
   * Resolves the id of the last assistant message in a session, tracking it
   * from history loads and SSE `message.updated` events, fetching messages on
   * demand when unknown.
   */
  async getLastAssistantMessageId(sessionId: string): Promise<string | undefined> {
    const known = this.lastAssistantMessageId.get(sessionId);
    if (known !== undefined) {
      return known;
    }
    const res = await getClient().session.messages({ sessionID: sessionId });
    const list = res.data ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].info.role === 'assistant') {
        return list[i].info.id;
      }
    }
    return undefined;
  }

  /** Drops the tracked id for a session (stale after a failed undo/revert). */
  clearLastAssistantMessageId(sessionId: string): void {
    this.lastAssistantMessageId.delete(sessionId);
  }
}
