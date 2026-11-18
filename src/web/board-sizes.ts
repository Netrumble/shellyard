// The size the user gave each area on the board. It is how this browser lays the board out,
// not part of the work itself, so it lives in the browser's storage.

export interface AreaSize {
  width: number;
  height: number;
}

export type AreaSizes = Record<string, AreaSize>;

const KEY = 'shellyard-area-sizes';
const LIMITS = { minWidth: 220, minHeight: 130, maxWidth: 2400, maxHeight: 1600 };
/** The key under which the box for sessions with no area keeps its size. */
export const NO_AREA_KEY = '(none)';

export function clampAreaSize(size: AreaSize): AreaSize {
  const fit = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));
  return { width: fit(size.width, LIMITS.minWidth, LIMITS.maxWidth), height: fit(size.height, LIMITS.minHeight, LIMITS.maxHeight) };
}

/** Reads the stored sizes, keeping only entries that really are sizes. */
export function parseAreaSizes(raw: string | null): AreaSizes {
  const out: AreaSizes = {};
  if (!raw) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return out;
  for (const [id, v] of Object.entries(data)) {
    if (typeof v !== 'object' || v === null) continue;
    const { width, height } = v as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) continue;
    out[id] = clampAreaSize({ width, height });
  }
  return out;
}

/** A copy of the sizes with one area's size set, or removed when `size` is null. */
export function withAreaSize(sizes: AreaSizes, id: string, size: AreaSize | null): AreaSizes {
  const next = { ...sizes };
  if (size) next[id] = clampAreaSize(size);
  else delete next[id];
  return next;
}

export function loadAreaSizes(): AreaSizes {
  try {
    return parseAreaSizes(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

export function saveAreaSizes(sizes: AreaSizes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sizes));
  } catch {
    // Not remembered next time; the board still shows the size for now.
  }
}
