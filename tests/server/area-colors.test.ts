import { describe, expect, it } from 'vitest';
import { hueOf, randomAreaColor, StoryStore } from '../../src/server/stories.js';
import { saveConfig, defaultConfig, loadConfig } from '../../src/server/config.js';
import { useTempHome } from '../helpers.js';

/** A source of "random" numbers that returns the given values in turn. */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};
const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('randomAreaColor', () => {
  it('gives a colour as #rrggbb', () => {
    expect(randomAreaColor([], Math.random)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('varies with the random source', () => {
    expect(randomAreaColor([], seq(0.1))).not.toBe(randomAreaColor([], seq(0.6)));
  });

  it('keeps away from the colours already in use', () => {
    const used = ['#e5484d', '#3fae5a', '#6aa6f0'];
    for (let run = 0; run < 40; run++) {
      const c = randomAreaColor(used, Math.random);
      const nearest = Math.min(...used.map((u) => hueGap(hueOf(u), hueOf(c))));
      expect(nearest, `${c} against ${used.join(',')}`).toBeGreaterThan(25);
    }
  });

  it('is always bright enough to read on the dark panel, and never grey', () => {
    for (let run = 0; run < 60; run++) {
      const c = randomAreaColor([], Math.random);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
      expect(Math.max(r, g, b)).toBeGreaterThan(150);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(60);
    }
  });

  it('still answers when many colours are taken, and ignores entries that are not colours', () => {
    const many = Array.from({ length: 40 }, (_, i) => `#${(i * 6).toString(16).padStart(2, '0')}80c0`);
    expect(randomAreaColor([...many, '', 'nonsense'], Math.random)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('hueOf', () => {
  it('reads the hue of a colour in degrees', () => {
    expect(hueOf('#ff0000')).toBeCloseTo(0);
    expect(hueOf('#00ff00')).toBeCloseTo(120);
    expect(hueOf('#0000ff')).toBeCloseTo(240);
  });
});

describe('areas and their colours', () => {
  useTempHome();

  it('gives a new area a random colour when none was chosen', () => {
    const store = new StoryStore();
    const a = store.create({ name: 'A' });
    const b = store.create({ name: 'B' });
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(hueGap(hueOf(a.color), hueOf(b.color))).toBeGreaterThan(25);
  });

  it('keeps the colour that was chosen', () => {
    expect(new StoryStore().create({ name: 'A', color: '#123456' }).color).toBe('#123456');
  });

  it('gives a random colour in place of something that is not a colour', () => {
    expect(new StoryStore().create({ name: 'A', color: 'javascript:alert(1)' }).color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('does not change the colour of an area when it is edited', () => {
    const store = new StoryStore();
    const a = store.create({ name: 'A' });
    expect(store.update(a.id, { name: 'Renamed' })!.color).toBe(a.color);
    expect(store.update(a.id, { color: '#abcdef' })!.color).toBe('#abcdef');
  });

  it('gives a colour to areas saved before colours were automatic, once, and announces it', () => {
    saveConfig({ ...defaultConfig(), stories: [{ id: 's1', name: 'Old', ticket: '', cwd: '', color: '', sound: '' }, { id: 's2', name: 'Has one', ticket: '', cwd: '', color: '#123456', sound: '' }] });
    const store = new StoryStore();
    let changes = 0;
    store.onChange(() => changes++);
    store.ensureColors();
    const [old, kept] = loadConfig().config.stories;
    expect(old!.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(kept!.color).toBe('#123456');
    expect(changes).toBe(1);
    store.ensureColors();
    expect(loadConfig().config.stories[0]!.color).toBe(old!.color);
    expect(changes).toBe(1);
  });
});
