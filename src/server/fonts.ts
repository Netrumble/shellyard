import type { TerminalFont } from '../shared/types.js';

// The font of a terminal: a family name and a size, either of which may be left to the
// default. The name ends up in a style of the page, so only a plain font name is accepted.

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

/** A usable font from anything, or null when it says nothing usable. */
export function normalizeFont(v: unknown): TerminalFont | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.family === 'string' ? o.family.trim() : '';
  const family = FAMILY.test(name) ? name : null;
  const rounded = typeof o.size === 'number' && Number.isFinite(o.size) ? Math.round(o.size) : null;
  const size = rounded !== null && rounded >= MIN_FONT_SIZE && rounded <= MAX_FONT_SIZE ? rounded : null;
  return family === null && size === null ? null : { family, size };
}
