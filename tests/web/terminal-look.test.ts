import { describe, expect, it } from 'vitest';
import { hostStyle, terminalFont, terminalLook } from '../../src/web/terminal-look.js';

const dark = { termBg: '#0d0c0f', termFg: '#dedad2' };
const light = { termBg: '#fbfbfd', termFg: '#1f2228' };

describe('terminalLook', () => {
  it('follows the theme when no background was chosen', () => {
    expect(terminalLook(null, 'dark', dark)).toMatchObject({ background: '#0d0c0f', foreground: '#dedad2', minimumContrastRatio: 1 });
    expect(terminalLook(null, 'light', light)).toMatchObject({ background: '#fbfbfd', foreground: '#1f2228', minimumContrastRatio: 4.5 });
  });
  it('treats the terminal of the Talentia theme as a dark one', () => {
    expect(terminalLook(null, 'talentia', { termBg: '#130b35', termFg: '#f2f2f2' })).toMatchObject({ background: '#130b35', foreground: '#f2f2f2', minimumContrastRatio: 1 });
  });

  it('uses a chosen dark colour with light text, whatever the theme', () => {
    const look = terminalLook({ color: '#101820', image: null, veil: 0.55 }, 'light', light);
    expect(look).toMatchObject({ background: '#101820', foreground: '#dedad2', minimumContrastRatio: 1 });
  });

  it('uses a chosen light colour with dark text, kept readable', () => {
    const look = terminalLook({ color: '#f5f0e6', image: null, veil: 0.55 }, 'dark', dark);
    expect(look).toMatchObject({ background: '#f5f0e6', foreground: '#1f2228', minimumContrastRatio: 4.5 });
  });

  it('lets an image show through, with light text over its dark veil', () => {
    const look = terminalLook({ color: null, image: 'a.png', veil: 0.6 }, 'light', light);
    expect(look.background).toBe('#00000000');
    expect(look).toMatchObject({ foreground: '#dedad2', minimumContrastRatio: 1 });
  });

  it('keeps text readable when the veil over an image is thin', () => {
    // Little veil means the image itself is the background: ask xterm to guard the contrast.
    expect(terminalLook({ color: null, image: 'a.png', veil: 0.1 }, 'dark', dark).minimumContrastRatio).toBe(4.5);
  });
});

describe('hostStyle', () => {
  it('is empty without an image', () => {
    expect(hostStyle(null, null)).toEqual({});
    expect(hostStyle({ color: '#101820', image: null, veil: 0.5 }, null)).toEqual({});
    expect(hostStyle({ color: null, image: 'a.png', veil: 0.5 }, null)).toEqual({});
  });
  it('lays a grey-black veil over the image', () => {
    const style = hostStyle({ color: null, image: 'a.png', veil: 0.6 }, 'blob:abc');
    expect(style.backgroundImage).toBe('linear-gradient(rgba(12, 12, 14, 0.6), rgba(12, 12, 14, 0.6)), url("blob:abc")');
    expect(style.backgroundSize).toBe('cover');
  });
});

describe('terminalFont', () => {
  it('uses the usual stack and size when nothing was chosen', () => {
    expect(terminalFont(null)).toEqual({ fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace', fontSize: 13 });
  });
  it('puts a chosen font first, and keeps the stack behind it for a machine without that font', () => {
    expect(terminalFont({ family: 'JetBrains Mono', size: 16 })).toEqual({ fontFamily: '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace', fontSize: 16 });
  });
  it('takes a size alone, or a font alone', () => {
    expect(terminalFont({ family: null, size: 18 }).fontSize).toBe(18);
    expect(terminalFont({ family: null, size: 18 }).fontFamily).toMatch(/^"Cascadia Mono"/);
    expect(terminalFont({ family: 'Consolas', size: null })).toMatchObject({ fontSize: 13 });
  });
});
