import type { TerminalBackground, TerminalFont } from '../shared/types.js';
import type { Theme } from './theme.js';

// How a terminal is drawn, given the background chosen for it (if any) and the theme.

export interface TerminalLook {
  background: string;
  foreground: string;
  /** Above 1, xterm adjusts text colours that would be hard to read on the background. */
  minimumContrastRatio: number;
  /** True when the text is light on a dark background. */
  lightText: boolean;
}

/** The terminal colours of each theme, as theme.css declares them (a test keeps the two equal). */
export const THEME_TERMINAL: Record<Theme, { termBg: string; termFg: string }> = {
  dark: { termBg: '#0d0c0f', termFg: '#dedad2' },
  light: { termBg: '#fbfbfd', termFg: '#1f2228' },
  talentia: { termBg: '#130b35', termFg: '#f2f2f2' },
};

/** Only the light theme has a light terminal; the Talentia page is light around a dark one. */
export function terminalIsLight(theme: Theme): boolean {
  return theme === 'light';
}

const LIGHT_TEXT = '#dedad2';
const DARK_TEXT = '#1f2228';
/** The veil over an image is this colour: a grey-black, not a pure black. */
const VEIL_RGB = '12, 12, 14';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function terminalLook(background: TerminalBackground | null, theme: Theme, themeColors: { termBg: string; termFg: string }): TerminalLook {
  if (background?.image) {
    // The image is drawn behind a transparent terminal. Under a thick veil it is dark, and
    // light text reads well; under a thin one anything can be behind a letter.
    return { background: '#00000000', foreground: LIGHT_TEXT, minimumContrastRatio: background.veil < 0.35 ? 4.5 : 1, lightText: true };
  }
  if (background?.color) {
    const light = luminance(background.color) > 0.35;
    return { background: background.color, foreground: light ? DARK_TEXT : LIGHT_TEXT, minimumContrastRatio: light ? 4.5 : 1, lightText: !light };
  }
  const light = terminalIsLight(theme);
  return { background: themeColors.termBg, foreground: themeColors.termFg, minimumContrastRatio: light ? 4.5 : 1, lightText: !light };
}

/** The style of the element behind the terminal: the image under its veil, when there is one. */
export function hostStyle(background: TerminalBackground | null, imageUrl: string | null): Record<string, string> {
  if (!background?.image || !imageUrl) return {};
  const veil = `rgba(${VEIL_RGB}, ${background.veil})`;
  return {
    backgroundImage: `linear-gradient(${veil}, ${veil}), url("${imageUrl}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  };
}

/**
 * The fonts a terminal falls back through; the first one installed is used. The Nerd Font
 * names come after the usual fonts so the icons they carry (git branch, folders...) still show:
 * the Mono variants first, whose icons fit one cell as the terminal draws them (the others' are
 * wider and overlap the next character). Then `monospace`, before the emoji fonts: these carry
 * the digits, `#` and `*` too (keycap bases), and on a machine with none of the fonts named
 * (a Mac out of the box) they would draw every digit. Fallback goes on per character past a
 * generic family, so pictographs still reach the colour fonts.
 */
const FONT_STACK =
  '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", ' +
  '"CaskaydiaCove Nerd Font Mono", "CaskaydiaCove NFM", "Symbols Nerd Font Mono", ' +
  '"CaskaydiaCove Nerd Font", "CaskaydiaCove NF", "Symbols Nerd Font", monospace, ' +
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"';
export const DEFAULT_FONT_SIZE = 13;

/** Fixed-width fonts commonly installed, offered by name. Any other can be typed. */
export const FONT_CHOICES = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New', 'Lucida Console', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'DejaVu Sans Mono', 'Ubuntu Mono', 'Menlo'];

/** The font settings of a terminal: the chosen font first, the usual ones behind it. */
export function terminalFont(font: TerminalFont | null): { fontFamily: string; fontSize: number } {
  return { fontFamily: font?.family ? `"${font.family}", ${FONT_STACK}` : FONT_STACK, fontSize: font?.size ?? DEFAULT_FONT_SIZE };
}
