import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_TERMINAL } from '../../src/web/terminal-look.js';

const css = readFileSync(join(__dirname, '..', '..', 'src', 'web', 'theme.css'), 'utf8').replace(/\r\n/g, '\n');

/** The variables one block of the stylesheet sets, by name. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]!] = m[2]!.trim();
  return out;
}

const dark = block(':root');
const light = block(":root[data-theme='light']");
const talentia = block(":root[data-theme='talentia']");
const talentiaSidebar = block(":root[data-theme='talentia'] .sidebar");

/** The variables in force in a place: those of the theme over those of :root; var() resolved. */
function resolver(...layers: Array<Record<string, string>>): (name: string) => string {
  const vars = Object.assign({}, ...layers) as Record<string, string>;
  const get = (name: string, depth = 0): string => {
    const v = vars[name];
    if (v === undefined) throw new Error(`no ${name}`);
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    if (ref && depth < 5) return get(ref[1]!, depth + 1);
    return v;
  };
  return get;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const places: Array<[string, (name: string) => string]> = [
  ['dark', resolver(dark)],
  ['light', resolver(dark, light)],
  ['talentia', resolver(dark, talentia)],
  ['talentia sidebar', resolver(dark, talentia, talentiaSidebar)],
];
const surfaces = ['--bg', '--panel', '--panel-2'];

describe('theme.css', () => {
  it('gives the Talentia theme a value for every colour the light theme sets', () => {
    expect(Object.keys(light).filter((name) => !(name in talentia))).toEqual([]);
  });
  it('builds the Talentia theme on the colours of the brand', () => {
    expect(talentia['--accent']).toBe('#d0006f');
    expect(talentia['--brand-navy']).toBe('#23135f');
    expect(talentia['--done']).toBe('#4438b6');
    expect(talentia['--dial-yellow']).toBe('#2dccd3');
  });
  it('draws terminals with the colours each theme declares', () => {
    expect(THEME_TERMINAL.dark).toEqual({ termBg: dark['--term-bg'], termFg: dark['--term-fg'] });
    expect(THEME_TERMINAL.light).toEqual({ termBg: light['--term-bg'], termFg: light['--term-fg'] });
    expect(THEME_TERMINAL.talentia).toEqual({ termBg: talentia['--term-bg'], termFg: talentia['--term-fg'] });
  });

  it.each(places)('keeps text at 4.5:1 or more on every surface (%s)', (_, get) => {
    for (const fg of ['--text', '--muted']) {
      for (const bg of surfaces) expect(contrast(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(places)('makes every state glyph stand out 3:1 or more from every surface (%s)', (_, get) => {
    for (const fg of ['--glyph-needs', '--glyph-working', '--glyph-finished', '--glyph-idle']) {
      for (const bg of surfaces) expect(contrast(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('moves the glyphs only with full effects and no request for reduced motion', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: no-preference) {');
    expect(start).toBeGreaterThan(-1);
    const end = css.indexOf('\n}\n', start);
    const gated = css.slice(start, end);
    for (const name of ['glyph-pulse', 'glyph-spin']) {
      const uses = [...css.matchAll(new RegExp(`animation: ${name}\\b`, 'g'))].map((m) => m.index);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const at of uses) expect(at > start && at < end, `${name} outside the motion block`).toBe(true);
    }
    for (const rule of gated.matchAll(/^\s+([^{}\n]+) \{/gm)) expect(rule[1]).toMatch(/^:root\[data-effects='full'\] /);
  });
});
