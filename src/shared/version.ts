/** Product version, injected by the build (falls back for tests and dev runs). */

declare const __STRUCTLENS_VERSION__: string | undefined;

export const VERSION: string = typeof __STRUCTLENS_VERSION__ === 'string' ? __STRUCTLENS_VERSION__ : '2.1.0-dev';
