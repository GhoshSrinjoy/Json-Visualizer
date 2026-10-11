/** Build-time virtual modules (see scripts/build.mjs). */
declare module 'virtual:data-worker' {
  const source: string;
  export default source;
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface Window {
  __STRUCTLENS__?: {
    host: 'vscode' | 'server' | 'browser';
    token?: string;
    /** Initial payload embedded by the host (VS Code). */
    init?: import('../shared/protocol').InitPayload;
  };
}

declare module '*.css';
