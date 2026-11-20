/** The parts of a key event the shortcuts look at. */
export interface KeyLike {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * The launcher Alt+1 to Alt+9 starts (0 for the first), or null. By position of the key, so it
 * works on any keyboard layout. Ctrl+Alt is AltGr on Windows and types characters, so it is
 * not a shortcut. A terminal or a text field with the focus keeps its keys: Alt+digit means
 * something to a shell.
 */
export function launcherIndex(e: KeyLike, launchers: number, typingSomewhere: boolean): number | null {
  if (typingSomewhere || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (!m) return null;
  const i = Number(m[1]) - 1;
  return i < launchers ? i : null;
}

/** Whether the focus is where keys are typed: a terminal, a text field, a list to pick from. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest('.xterm')) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}
