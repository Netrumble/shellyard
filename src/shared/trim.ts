/** The part of a sound that plays; the page and the server check it the same way. */
export interface Trim {
  start: number;
  end: number | null;
}

/** No sound is an hour long; a cut beyond that is a mistake. */
export const MAX_TRIM_SECONDS = 3600;

export const TRIM_RULE = `Start and End must be 0 to ${MAX_TRIM_SECONDS} seconds, with End empty or after Start.`;

const round = (n: number): number => Math.round(n * 100) / 100;

/** A number of seconds a cut may hold: 0 to MAX_TRIM_SECONDS. */
const isTrimSeconds = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_TRIM_SECONDS;

/**
 * The part of a sound that plays: a start of 0 or more seconds and an end after it, or no end
 * (null or absent: the end of the file). Rounded to hundredths. Null when it is not valid.
 */
export function parseTrim(start: unknown, end: unknown): Trim | null {
  if (!isTrimSeconds(start)) return null;
  if (end === null || end === undefined) return { start: round(start), end: null };
  if (!isTrimSeconds(end) || round(end) <= round(start)) return null;
  return { start: round(start), end: round(end) };
}

/** A typed number of seconds ('' for none): digits with a point or a comma, nothing else (no 1e1, no 0x10). */
export function typedSeconds(text: string): number | null | undefined {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  return /^(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : undefined;
}

/** The cut two typed fields hold (an empty Start is 0), checked and rounded as the server does; null when it is not valid. */
export function typedTrim(start: string, end: string): Trim | null {
  const s = typedSeconds(start);
  const e = typedSeconds(end);
  return s === undefined || e === undefined ? null : parseTrim(s ?? 0, e);
}
