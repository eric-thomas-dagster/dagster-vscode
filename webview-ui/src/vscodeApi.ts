// `acquireVsCodeApi()` only exists inside a real VS Code webview, and can
// only be called ONCE per webview session -- a singleton module is the
// standard safe pattern. Falls back to a no-op outside VS Code (e.g. the
// plain-browser `npm run dev` preview used to sanity-check styling)
// rather than throwing.
declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

export const vscodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: () => {}, getState: () => undefined, setState: () => {} };
