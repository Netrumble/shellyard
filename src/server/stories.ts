import { randomUUID } from 'node:crypto';
import type { Story } from '../shared/types.js';
import { applyOrder } from './order.js';
import { assertConfigWritable, loadConfig, saveConfig } from './config.js';

export interface StoryInput {
  name?: string;
  ticket?: string;
  cwd?: string;
  color?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** The hue of a colour, in degrees. */
export function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * A colour for a new area: random, but as far in hue as chance allows from the colours other
 * areas already have, so that neighbours on the board can be told apart. Saturation and
 * lightness are fixed so that every result reads well on the dark panel.
 */
export function randomAreaColor(existing: string[], random: () => number): string {
  const used = existing.filter((c) => HEX.test(c)).map(hueOf);
  let best = random() * 360;
  let bestGap = -1;
  for (let i = 0; i < 24; i++) {
    const hue = i === 0 ? best : random() * 360;
    const gap = used.length === 0 ? 360 : Math.min(...used.map((u) => Math.min(Math.abs(u - hue), 360 - Math.abs(u - hue))));
    if (gap > bestGap) {
      best = hue;
      bestGap = gap;
    }
  }
  return hslToHex(best % 360, 0.65, 0.6);
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const cleanColor = (v: unknown): string => (/^#[0-9a-f]{6}$/i.test(clean(v)) ? clean(v) : '');

/**
 * The list of stories. A story is only a named place to put sessions: it lives in
 * config.json, so it outlasts the server, while its sessions do not.
 */
export class StoryStore {
  private readonly changeCbs: Array<(stories: Story[]) => void> = [];

  list(): Story[] {
    return loadConfig().config.stories;
  }

  create(input: StoryInput): Story {
    const name = clean(input.name);
    if (!name) throw new Error('A story needs a name.');
    assertConfigWritable();
    const story: Story = {
      id: `story-${randomUUID().slice(0, 8)}`,
      name,
      ticket: clean(input.ticket),
      cwd: clean(input.cwd),
      // Every area has a colour; one that was not chosen is picked at random.
      color: cleanColor(input.color) || randomAreaColor(this.list().map((s) => s.color), Math.random),
    };
    this.save([...this.list(), story]);
    return story;
  }

  update(id: string, patch: StoryInput): Story | null {
    const stories = this.list();
    const current = stories.find((s) => s.id === id);
    if (!current) return null;
    const next: Story = {
      ...current,
      name: clean(patch.name) || current.name,
      ticket: patch.ticket === undefined ? current.ticket : clean(patch.ticket),
      cwd: patch.cwd === undefined ? current.cwd : clean(patch.cwd),
      color: patch.color === undefined ? current.color : cleanColor(patch.color),
    };
    this.save(stories.map((s) => (s.id === id ? next : s)));
    return next;
  }

  remove(id: string): boolean {
    const stories = this.list();
    if (!stories.some((s) => s.id === id)) return false;
    this.save(stories.filter((s) => s.id !== id));
    return true;
  }

  /** Puts the areas in the given order (see applyOrder); returns the new list. */
  reorder(ids: string[]): Story[] {
    const next = applyOrder(this.list(), ids, (s) => s.id);
    this.save(next);
    return next;
  }

  /** Gives a colour to areas that have none (those saved before colours were automatic). */
  ensureColors(): void {
    const stories = this.list();
    if (stories.every((s) => s.color)) return;
    const next: Story[] = [];
    for (const s of stories) {
      next.push(s.color ? s : { ...s, color: randomAreaColor([...stories, ...next].map((x) => x.color), Math.random) });
    }
    try {
      this.save(next);
    } catch {
      // A config file that cannot be written right now; the areas stay as they are.
    }
  }

  onChange(cb: (stories: Story[]) => void): void {
    this.changeCbs.push(cb);
  }

  /** Rewrites only the stories; everything else in the file is read back and kept. */
  private save(stories: Story[]): void {
    assertConfigWritable();
    const { config } = loadConfig();
    saveConfig({ ...config, stories });
    for (const cb of this.changeCbs) cb(stories);
  }
}
