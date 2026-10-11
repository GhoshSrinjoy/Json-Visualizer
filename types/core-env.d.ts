// Minimal ambient declarations for APIs that exist in every runtime the core
// targets (Node >= 18, browsers, Web Workers). Only tsconfig.core.json loads
// this file; the full project gets the real typings from lib.dom / @types/node.
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string;
}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare const performance: { now(): number };
