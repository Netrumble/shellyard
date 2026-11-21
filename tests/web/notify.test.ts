import { describe, expect, it, vi } from 'vitest';
import { bringToFront, handleNotificationClick, viewForSession } from '../../src/web/notify.js';
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

describe('handleNotificationClick', () => {
  it('in a browser leaves the default alone, so the browser brings the tab to the front', () => {
    const e = { preventDefault: vi.fn() };
    const onClick = vi.fn();
    handleNotificationClick(e, onClick, { focus: vi.fn() } as unknown as Window);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
  });

  it('in the desktop app prevents the default and shows the window', () => {
    const e = { preventDefault: vi.fn() };
    const showWindow = vi.fn();
    handleNotificationClick(e, vi.fn(), { focus: vi.fn(), shellyardDesktop: { showWindow } } as unknown as Window);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(showWindow).toHaveBeenCalled();
  });
});

describe('viewForSession', () => {
  it('opens the session, or the board when it is gone', () => {
    const sessions = [{ id: 'a' }] as SessionInfo[];
    expect(viewForSession(sessions, 'a')).toEqual({ kind: 'single', id: 'a' });
    expect(viewForSession(sessions, 'b')).toEqual({ kind: 'board' });
  });
});
