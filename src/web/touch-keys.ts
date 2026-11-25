// The keys a phone keyboard lacks. On iOS the bar above the keyboard (↑ ↓ ✓) moves between
// form fields: it never reaches the terminal, so without these a menu such as Claude Code's
// trust prompt cannot be answered from a phone.

export type TouchKey = 'esc' | 'tab' | 'shift-tab' | 'up' | 'down' | 'left' | 'right' | 'enter' | 'ctrl-c';

export const TOUCH_KEYS: ReadonlyArray<{ key: TouchKey; label: string; title: string }> = [
  { key: 'esc', label: 'Esc', title: 'Escape' },
  { key: 'tab', label: 'Tab', title: 'Tab' },
  { key: 'shift-tab', label: '⇤', title: 'Shift+Tab' },
  { key: 'ctrl-c', label: '^C', title: 'Ctrl+C' },
  { key: 'left', label: '←', title: 'Left arrow' },
  { key: 'up', label: '↑', title: 'Up arrow' },
  { key: 'down', label: '↓', title: 'Down arrow' },
  { key: 'right', label: '→', title: 'Right arrow' },
  { key: 'enter', label: '⏎', title: 'Enter' },
];

const ARROWS: Partial<Record<TouchKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * The bytes a key sends, as a real keyboard in xterm would: arrows follow the cursor-key mode
 * a program has asked for (ESC O x in application mode, ESC [ x otherwise).
 */
export function touchKeySequence(key: TouchKey, applicationCursor: boolean): string {
  const arrow = ARROWS[key];
  if (arrow) return (applicationCursor ? '\x1bO' : '\x1b[') + arrow;
  switch (key) {
    case 'esc':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'shift-tab':
      return '\x1b[Z';
    case 'enter':
      return '\r';
    case 'ctrl-c':
      return '\x03';
    default:
      return '';
  }
}
