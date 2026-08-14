// Ambient declarations + DOM lib augmentations for the webview bundle.
// checkJs-only; no runtime effect. Covers pre-existing vanilla-DOM patterns:
//   - `acquireVsCodeApi` is injected by the VS Code webview runtime.
//   - stream containers carry ad-hoc render-throttle state (`_acc*` /
//     `_lastRender*`).
//   - event handlers call `e.target.closest(...)` / `node.contains(e.target)`
//     where `e.target` is typed `EventTarget` by the DOM lib.

declare function acquireVsCodeApi(): { postMessage(message: any): void };

interface Element {
  _accText?: string;
  _accThinking?: string;
  _lastRenderAt?: number;
  _lastRenderedLen?: number;
  // querySelector/querySelectorAll return `Element`, but every match here is
  // a real HTMLElement in the chat shell — expose the props the code uses.
  hidden: boolean;
  open: boolean;
}

interface EventTarget {
  closest(selectors: string): Element | null;
}

interface Node {
  contains(other: any): boolean;
}
