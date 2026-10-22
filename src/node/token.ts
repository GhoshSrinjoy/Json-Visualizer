/** Secrets for the local servers (agent bridge, web visualizer, MCP over HTTP). */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** A random URL-safe secret. */
export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison of a client-supplied secret with the expected one. */
export function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  return typeof header === 'string' ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)?.[1] : undefined;
}
