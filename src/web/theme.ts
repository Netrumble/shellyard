// Light, dark, or Talentia's own colours. The choice belongs to this browser; "system" follows
// what the operating system asks for (light or dark), and keeps following it if that changes.

export type Theme = 'light' | 'dark' | 'talentia';
export type ThemeChoice = 'system' | Theme;

const KEY = 'shellyard-theme';

export function toThemeChoice(saved: string | null): ThemeChoice {
  return saved === 'light' || saved === 'dark' || saved === 'talentia' ? saved : 'system';
}

export function resolveTheme(choice: ThemeChoice, systemPrefersLight: boolean): Theme {
  if (choice === 'system') return systemPrefersLight ? 'light' : 'dark';
  return choice;
}

export function loadThemeChoice(): ThemeChoice {
  try {
    return toThemeChoice(localStorage.getItem(KEY));
  } catch {
    return 'system';
  }
}

export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Not remembered next time; it still applies now.
  }
}

export function systemPrefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

/** Calls back whenever the system switches between light and dark. */
export function watchSystemTheme(cb: () => void): void {
  if (typeof matchMedia !== 'function') return;
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', cb);
}
