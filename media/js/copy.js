// ── Code-block copy button ────────────────────────────────────────────────
// One delegated document-level click listener handles every .code-copy
// button. Buttons are re-created on every streaming re-render (innerHTML
// swaps), so per-button wiring would leak listeners and double-fire;
// delegation survives re-renders with zero re-wiring.

let wired = false;

export function initCodeCopy() {
  if (wired) {
    return;
  }
  wired = true;
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.code-copy');
    if (!btn) {
      return;
    }
    const block = btn.closest('.code-block');
    if (!block) {
      return;
    }
    const code = block.querySelector('code');
    if (!code) {
      return;
    }
    // textContent is the exact code for both highlighted and plain branches:
    // the browser decodes entities and concatenates token spans. Never read
    // from a data attribute — huge codes and escaping hazards.
    copyText(btn, code.textContent);
  });
}

function copyText(btn, text) {
  const done = function () {
    showCopied(btn);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () {
      legacyCopy(btn, text, done);
    });
    return;
  }
  legacyCopy(btn, text, done);
}

// execCommand fallback for contexts where the async Clipboard API is missing
// or rejects (non-secure contexts, focus quirks). The textarea must be in the
// DOM and not display:none for execCommand('copy') to work; positioning it
// off-screen via CSSOM is allowed under the webview CSP (no style attributes
// in markup, no eval).
function legacyCopy(btn, text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(ta);
  if (ok) {
    done();
  }
  // On failure: silently restore state — no toast, keep this minimal.
}

function showCopied(btn) {
  if (btn._copyTimer) {
    clearTimeout(btn._copyTimer);
  }
  const original = btn.textContent;
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  btn._copyTimer = setTimeout(function () {
    btn.textContent = original;
    btn.classList.remove('copied');
    btn._copyTimer = null;
  }, 2000);
}