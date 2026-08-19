// Minimal ambient types for `prismjs` (the package ships no bundled types).
// Only the surface the webview uses is declared; checkJs-only, no runtime
// effect. `import Prism from 'prismjs'` must type-check against this.

declare module 'prismjs' {
  export interface Grammar {
    [key: string]: unknown;
  }

  export const languages: Record<string, Grammar>;

  export function highlight(code: string, grammar: Grammar, language: string): string;

  export function tokenize(code: string, grammar: Grammar): unknown[];

  const Prism: {
    languages: typeof languages;
    highlight: typeof highlight;
    tokenize: typeof tokenize;
    // Set by the webview to disable Prism's auto-highlight DOM pass; we call
    // highlight() directly on freshly rendered code blocks.
    manual: boolean;
  };

  export default Prism;
}