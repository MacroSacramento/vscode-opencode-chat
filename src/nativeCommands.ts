import { getClient } from './opencodeClient';
import type { SnapshotFileDiff } from '@opencode-ai/sdk/dist/v2/client';
import type { ProviderContext } from './webview/types';
import type { HistoryService } from './sessions/history';
import type { SessionManager } from './sessions/manager';

/** Renders a short, readable summary of a session diff (capped at 2000 chars). */
export function buildDiffText(diffs: Array<SnapshotFileDiff>): string {
  if (diffs.length === 0) {
    return 'No changes';
  }
  const sections = diffs.map((d) => {
    const header = `${d.file ?? '(unknown)'} (${d.additions}+/${d.deletions}-)`;
    const patch = d.patch === undefined ? '' : d.patch.trim();
    return patch === '' ? header : `${header}\n${patch}`;
  });
  const joined = sections.join('\n\n---\n\n');
  return joined.length > 2000 ? `${joined.slice(0, 2000)}…` : joined;
}

/**
 * Executes a native session command (undo/redo/diff/fork/share/abort/compact)
 * and posts its result as `nativeResult`. `history` resolves the undo target
 * and drops it when stale; `sessions` refreshes the list after a fork.
 */
export async function runNativeCommand(
  ctx: ProviderContext,
  sessionId: string,
  command: string,
  history: HistoryService,
  sessions: SessionManager,
): Promise<void> {
  try {
    switch (command) {
      case 'undo': {
        const messageId = await history.getLastAssistantMessageId(sessionId);
        if (messageId === undefined) {
          ctx.post({ type: 'error', message: 'Nothing to undo in this session.' });
          return;
        }
        try {
          await getClient().session.revert({ sessionID: sessionId, messageID: messageId });
        } catch (err) {
          // The tracked id is stale (the target message no longer exists);
          // drop it so the next undo re-resolves instead of retrying a dead id.
          history.clearLastAssistantMessageId(sessionId);
          throw err;
        }
        ctx.post({ type: 'nativeResult', sessionId, text: 'Reverted' });
        break;
      }
      case 'redo': {
        await getClient().session.unrevert({ sessionID: sessionId });
        ctx.post({ type: 'nativeResult', sessionId, text: 'Restored' });
        break;
      }
      case 'diff': {
        const res = await getClient().session.diff({ sessionID: sessionId });
        const text = buildDiffText(res.data ?? []);
        ctx.post({ type: 'nativeResult', sessionId, text });
        break;
      }
      case 'fork': {
        const res = await getClient().session.fork({ sessionID: sessionId });
        const forked = res.data;
        await sessions.refresh();
        ctx.post({ type: 'nativeResult', sessionId, text: forked !== undefined ? `Forked session ${forked.id}` : 'Forked' });
        break;
      }
      case 'share': {
        const res = await getClient().session.share({ sessionID: sessionId });
        ctx.post({ type: 'nativeResult', sessionId, text: res.data?.share?.url ?? 'Shared' });
        break;
      }
      case 'abort': {
        await getClient().session.abort({ sessionID: sessionId });
        ctx.post({ type: 'nativeResult', sessionId, text: 'Aborted' });
        break;
      }
      case 'compact': {
        // SDK surprise: `session.compact` lives on the v2 client
        // (client.v2.session.compact), not on client.session.
        await getClient().v2.session.compact({ sessionID: sessionId });
        ctx.post({ type: 'nativeResult', sessionId, text: 'Compacted' });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.post({ type: 'error', message: `Failed to ${command}: ${detail}` });
  }
}
