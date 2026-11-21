import { describe, expect, it, vi } from 'vitest';
import { bringToFront, viewForSession } from '../../src/web/notify.js';
import type { SessionInfo } from '../../src/shared/types.js';

describe('bringToFront', () => {
  it('asks the desktop app for its window, then focuses the page', () => {
    const calls: string[] = [];
    const w = { focus: () => calls.push('focus'), shellyardDesktop: { showWindow: () => calls.push('show') } };
    bringToFront(w as unknown as Window);
    expect(calls).toEqual(['show', 'focus']);
  });

  it('only focuses in a browser, and still focuses if the app fails', () => {
    const focus = vi.fn();
    bringToFront({ focus } as unknown as Window);
    bringToFront({ focus, shellyardDesktop: { showWindow: () => { throw new Error('gone'); } } } as unknown as Window);
    expect(focus).toHaveBeenCalledTimes(2);
  });
});

describe('viewForSession', () => {
  it('opens the session, or the board when it is gone', () => {
    const sessions = [{ id: 'a' }] as SessionInfo[];
    expect(viewForSession(sessions, 'a')).toEqual({ kind: 'single', id: 'a' });
    expect(viewForSession(sessions, 'b')).toEqual({ kind: 'board' });
  });
});
