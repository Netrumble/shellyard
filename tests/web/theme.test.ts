import { describe, expect, it } from 'vitest';
import { resolveTheme, toThemeChoice } from '../../src/web/theme.js';

describe('theme', () => {
  it('follows the system when no choice was made, or when "system" was chosen', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
  it('uses an explicit choice whatever the system prefers', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('talentia', true)).toBe('talentia');
    expect(resolveTheme('talentia', false)).toBe('talentia');
  });
  it('reads a stored choice, falling back to "system" for anything else', () => {
    expect(toThemeChoice('light')).toBe('light');
    expect(toThemeChoice('dark')).toBe('dark');
    expect(toThemeChoice('talentia')).toBe('talentia');
    expect(toThemeChoice('system')).toBe('system');
    expect(toThemeChoice(null)).toBe('system');
    expect(toThemeChoice('purple')).toBe('system');
  });
});
