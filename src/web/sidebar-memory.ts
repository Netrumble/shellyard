export const SIDEBAR_FOLDED_KEY = 'shellyard-sidebar-folded';
export const LAUNCHERS_FOLDED_KEY = 'shellyard-launchers-folded';

/** Whether a part of the sidebar is folded is a convenience of this browser, not shared state. */
export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Not remembered next time; nothing else depends on it.
  }
}
