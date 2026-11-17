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
});
