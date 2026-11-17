import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalBackground } from '../shared/types.js';
import { dataDir } from './config.js';

// What is behind the text of a terminal: a colour, or an image the user uploaded, with a
// dark veil over it so that text stays readable. Images are kept in TTC's own folder under
// names TTC makes up, and a background can only ever refer to one of those names: nothing
// in a background is a path or an address.

const HEX = /^#[0-9a-f]{6}$/i;
const IMAGE_NAME = /^[0-9a-f-]{1,64}\.(png|jpg|webp|gif)$/;
const DEFAULT_VEIL = 0.55;
const MAX_VEIL = 0.95;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** A background as it may be stored, or null if there is nothing valid in it. */
export function normalizeBackground(v: unknown): TerminalBackground | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const image = typeof o.image === 'string' && IMAGE_NAME.test(o.image) ? o.image : null;
  // An image and a colour are alternatives; the image wins if both are given.
  const color = image === null && typeof o.color === 'string' && HEX.test(o.color) ? o.color.toLowerCase() : null;
  if (image === null && color === null) return null;
  const veil = typeof o.veil === 'number' && Number.isFinite(o.veil) ? Math.min(MAX_VEIL, Math.max(0, o.veil)) : DEFAULT_VEIL;
  return { color, image, veil };
}

/** What kind of image some bytes are, judged by the bytes and not by a name or a header. */
export function imageKind(bytes: Buffer): { ext: string; type: string } | null {
  const starts = (...sig: number[]): boolean => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', type: TYPES.png! };
  if (starts(0xff, 0xd8, 0xff)) return { ext: 'jpg', type: TYPES.jpg! };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { ext: 'gif', type: TYPES.gif! };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', type: TYPES.webp! };
  }
  return null;
}

function folder(): string {
  const dir = join(dataDir(), 'backgrounds');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Saves an uploaded image and returns the name to refer to it by; null if it is not an image. */
export function saveImage(bytes: Buffer): string | null {
  const kind = imageKind(bytes);
  if (!kind) return null;
  const name = `${randomUUID()}.${kind.ext}`;
  writeFileSync(join(folder(), name), bytes);
  return name;
}

/** The bytes and type of a stored image; null for anything that is not one of its names. */
export function readImage(name: string): { bytes: Buffer; type: string } | null {
  if (!IMAGE_NAME.test(name)) return null;
  const file = join(folder(), name);
  if (!existsSync(file)) return null;
  const ext = name.slice(name.lastIndexOf('.') + 1);
  return { bytes: readFileSync(file), type: TYPES[ext] ?? 'application/octet-stream' };
}
