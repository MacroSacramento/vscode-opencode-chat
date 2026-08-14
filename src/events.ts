import { getClient, getServerUrl, isConnected, markDisconnected } from './opencodeClient';
import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/dist/v2/gen/types.gen';

/**
 * Events delivered by the legacy `/event` SSE endpoint. Each member is a
 * discriminated union on `type` with a `properties` payload (the newer
 * `/api/event` surface uses `data` instead).
 */
export type OpenCodeEvent = OpenCodeSdkEvent;

const LOG_PREFIX = '[opencode-chat]';
const RESUBSCRIBE_DELAY_MS = 2000;
// Consecutive stream failures before the connection is marked disconnected so
// the extension's retry timer can re-establish it (guards against the status
// bar lying "connected" while the server is down).
const MAX_CONSECUTIVE_FAILURES = 3;

let running = false;
let stopped = false;
let abortController: AbortController | undefined;
let consecutiveFailures = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start forwarding events from the OpenCode server's SSE stream to `onEvent`.
 * Idempotent: a no-op while the stream is already running. Resubscribes after
 * a 2s delay whenever the stream ends or fails, as long as the client is still
 * connected and `stopEventStream()` has not been called.
 */
export function startEventStream(
  onEvent: (event: { type: string; properties: any }) => void,
  log?: (message: string) => void,
): void {
  if (running) {
    return;
  }
  running = true;
  stopped = false;
  abortController = new AbortController();
  void runLoop(onEvent, log, abortController);
}

async function runLoop(
  onEvent: (event: { type: string; properties: any }) => void,
  log?: (message: string) => void,
  controller?: AbortController,
): Promise<void> {
  const aborted = (): boolean => stopped || controller?.signal.aborted === true;
  try {
    while (!aborted()) {
      if (!isConnected()) {
        log?.(`${LOG_PREFIX} event stream stopped: server not connected`);
        return;
      }
      let stream: AsyncGenerator<OpenCodeEvent, unknown, unknown> | undefined;
      try {
        const client = getClient();
        // The v2 client's Event.subscribe(parameters, options) keeps query
        // params in the 1st argument ({ directory, workspace }) and spreads
        // everything else into the fetch RequestInit — including `signal`
        // (RequestInit.signal survives in Options). The 1st arg must stay
        // undefined so the signal in the 2nd arg reaches the SSE client and
        // aborts the underlying fetch.
        const events = await client.event.subscribe(undefined, { signal: controller?.signal });
        stream = events.stream;
        consecutiveFailures = 0;
        log?.(`${LOG_PREFIX} event stream subscribed (${getServerUrl()})`);
        // Iterate manually so a stop can win a race against a pending read;
        // `for await` would stay blocked on the live SSE connection otherwise.
        while (!aborted()) {
          const nextPromise = stream.next().then(
            (result) => ({ kind: 'value' as const, result }),
            (error: unknown) => ({ kind: 'error' as const, error }),
          );
          // Stop race with a removable listener so we do not accumulate one
          // abort listener per delivered event (Defect A from review).
          let removeAbortListener: (() => void) | undefined;
          const stopP = new Promise<{ kind: 'stop' }>((resolve) => {
            const handler = (): void => resolve({ kind: 'stop' });
            if (controller?.signal.aborted) {
              resolve({ kind: 'stop' });
              return;
            }
            controller?.signal.addEventListener('abort', handler, { once: true });
            removeAbortListener = (): void => controller?.signal.removeEventListener('abort', handler);
          });
          const outcome = await Promise.race([nextPromise, stopP]);
          if (outcome.kind !== 'stop') {
            removeAbortListener?.();
          }
          if (outcome.kind === 'stop') {
            break;
          }
          if (outcome.kind === 'error') {
            consecutiveFailures += 1;
            log?.(`${LOG_PREFIX} event stream read error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              log?.(`${LOG_PREFIX} event stream failed ${consecutiveFailures} consecutive times; marking disconnected`);
              markDisconnected();
              return;
            }
            break;
          }
          if (outcome.result.done) {
            break;
          }
          onEvent(outcome.result.value);
          consecutiveFailures = 0;
        }
        if (aborted()) {
          return;
        }
        log?.(`${LOG_PREFIX} event stream ended; resubscribing`);
      } catch (err) {
        if (aborted()) {
          return;
        }
        consecutiveFailures += 1;
        const detail = err instanceof Error ? err.message : String(err);
        log?.(`${LOG_PREFIX} event stream error: ${detail}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log?.(`${LOG_PREFIX} event stream failed ${consecutiveFailures} consecutive times; marking disconnected`);
          markDisconnected();
          return;
        }
      } finally {
        // Belt-and-suspenders: end the generator so its internal retry sleep
        // (up to 3s) does not delay the loop exit; the aborted signal already
        // cancelled the underlying fetch reader.
        void stream?.return(undefined);
      }
      // Stream exited (ended or errored). Resubscribe after a delay unless
      // stopped or no longer connected. The delay is abort-aware so a stop
      // lands immediately even mid-sleep.
      if (!isConnected()) {
        log?.(`${LOG_PREFIX} event stream stopped: server not connected`);
        return;
      }
      // Resubscribe after a delay unless stopped or no longer connected. The
      // delay is abort-aware so a stop lands immediately even mid-sleep.
      let removeSleepAbortListener: (() => void) | undefined;
      const sleepRace = await Promise.race([
        sleep(RESUBSCRIBE_DELAY_MS).then(() => 'sleep' as const),
        new Promise<'stop'>((resolve) => {
          const handler = (): void => resolve('stop');
          if (controller?.signal.aborted) {
            resolve('stop');
            return;
          }
          controller?.signal.addEventListener('abort', handler, { once: true });
          removeSleepAbortListener = (): void => controller?.signal.removeEventListener('abort', handler);
        }),
      ]);
      if (sleepRace !== 'stop') {
        removeSleepAbortListener?.();
      }
    }
  } finally {
    // Only the newest stream clears the running flag (a stale loop from a
    // previous stop/start cycle must not clobber the current one).
    if (controller === abortController) {
      running = false;
    }
  }
}

/**
 * Stops the current stream loop and prevents resubscription. Aborts the
 * underlying SSE subscription so a pending `for await` terminates promptly.
 */
export function stopEventStream(): void {
  stopped = true;
  abortController?.abort();
}

export function isEventStreamRunning(): boolean {
  return running;
}
