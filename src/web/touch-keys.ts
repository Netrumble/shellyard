import { useEffect, useState } from 'react';

// A phone's keyboard has no Escape, Tab, arrows or Ctrl. A program that is driven by them (the
// menus of Claude Code, the folder trust question first of all, whose answer is one arrow
// away) cannot be answered from a phone without them, so a touch screen gets them as buttons.

export type TouchKeyName = 'escape' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'enter' | 'ctrl-c';

export interface TouchKey {
  readonly name: TouchKeyName;
  /** What the button shows. */
  readonly label: string;
  /** What a screen reader says, and the tooltip. */
  readonly title: string;
}

/** The buttons, in the order they are shown. */
export const TOUCH_KEYS: readonly TouchKey[] = [
  { name: 'escape', label: 'Esc', title: 'Escape' },
  { name: 'tab', label: 'Tab', title: 'Tab' },
  { name: 'up', label: '↑', title: 'Up arrow' },
  { name: 'down', label: '↓', title: 'Down arrow' },
  { name: 'left', label: '←', title: 'Left arrow' },
  { name: 'right', label: '→', title: 'Right arrow' },
  { name: 'enter', label: '⏎', title: 'Enter' },
  { name: 'ctrl-c', label: '^C', title: 'Ctrl+C' },
];

const ARROW_FINAL: Record<'up' | 'down' | 'left' | 'right', string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * The bytes a key sends, as a keyboard would through the terminal. The arrows follow the
 * cursor key mode the program asked for: ESC O x in application mode, ESC [ x otherwise.
 */
export function touchKeySequence(name: TouchKeyName, applicationCursorKeys: boolean): string {
  switch (name) {
    case 'escape':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'enter':
      return '\r';
    case 'ctrl-c':
      return '\x03';
    default:
      return `\x1b${applicationCursorKeys ? 'O' : '['}${ARROW_FINAL[name]}`;
  }
}

/** A finger, not a mouse, is the main pointer: a phone or a tablet. */
export const TOUCH_QUERY = '(pointer: coarse)';

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches;
}

/** True while the main pointer is a finger; follows a keyboard and mouse being attached or not. */
export function useTouchScreen(): boolean {
  const [touch, setTouch] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(TOUCH_QUERY);
    const onChange = (): void => setTouch(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return touch;
}
