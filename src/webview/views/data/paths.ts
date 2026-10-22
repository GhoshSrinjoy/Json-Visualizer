/** JSONPath helpers for the data views. */

import type { PathSegment } from '../../../core/data/tree';

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The same field in every element of the enclosing arrays (`$.users[*].email`), or null outside arrays. */
export function similarPath(segments: PathSegment[]): string | null {
  if (!segments.some((s) => typeof s === 'number')) return null;
  return '$' + segments.map((s) => (typeof s === 'number' ? '[*]' : IDENT.test(s) ? `.${s}` : `['${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`)).join('');
}
