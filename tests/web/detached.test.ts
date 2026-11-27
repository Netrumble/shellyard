import { describe, expect, it, vi } from 'vitest';
import { boundsFor, boundsToSave, bringForward, detachedIdFrom, detachedUrl, droppedOutside, parseMessage, reach, windowFeatures, withBounds, type Bounds } from '../../src/web/detached.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('detachedIdFrom', () => {
  it('reads the session of a detached window from its address', () => {
    expect(detachedIdFrom(`?detached=${ID}`)).toBe(ID);
    expect(detachedIdFrom(detachedUrl(ID).slice(1))).toBe(ID);
  });

  it('gives null for the main page and for anything that is not a session id', () => {
    expect(detachedIdFrom('')).toBeNull();
    expect(detachedIdFrom('?detached=')).toBeNull();
    expect(detachedIdFrom('?detached=../api')).toBeNull();
    expect(detachedIdFrom('?other=1')).toBeNull();
  });
});

describe('parseMessage', () => {
  it('takes the messages of the channel', () => {
    expect(parseMessage({ t: 'who' })).toEqual({ t: 'who' });
    for (const t of ['open', 'closed', 'close', 'focus'] as const) expect(parseMessage({ t, id: ID })).toEqual({ t, id: ID });
  });

  it('drops anything else', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('open')).toBeNull();
    expect(parseMessage({ t: 'open' })).toBeNull();
    expect(parseMessage({ t: 'open', id: 'x' })).toBeNull();
    expect(parseMessage({ t: 'delete', id: ID })).toBeNull();
  });
});

describe('boundsFor and windowFeatures', () => {
  const saved: Bounds = { left: -1800, top: 120, width: 1000, height: 700 };

  it('opens where the drag dropped it, at the size it had', () => {
    expect(boundsFor(saved, { screenX: 2500, screenY: 300 })).toEqual({ left: 2460, top: 284, width: 1000, height: 700 });
  });

  it('opens where it was last, also on a monitor left of the main one', () => {
    const b = boundsFor(saved, null);
    expect(b).toEqual(saved);
    expect(windowFeatures(b)).toBe('popup,width=1000,height=700,left=-1800,top=120');
  });

  it('without a place, gives a size and leaves the position to the system', () => {
    const b = boundsFor(null, null);
    expect(windowFeatures(b)).toBe('popup,width=900,height=600');
  });

  it('never opens a window too small for a terminal', () => {
    expect(boundsFor({ left: 0, top: 0, width: 10, height: 10 }, null)).toMatchObject({ width: 360, height: 240 });
  });
});

describe('droppedOutside', () => {
  const win = { screenX: 100, screenY: 50, outerWidth: 1200, outerHeight: 800 };

  it('is true past any edge of the window', () => {
    expect(droppedOutside({ screenX: 50, screenY: 300 }, win)).toBe(true);
    expect(droppedOutside({ screenX: 1400, screenY: 300 }, win)).toBe(true);
    expect(droppedOutside({ screenX: 500, screenY: 20 }, win)).toBe(true);
    expect(droppedOutside({ screenX: 500, screenY: 900 }, win)).toBe(true);
  });

  it('is false inside the window, and for a drag ended without a position', () => {
    expect(droppedOutside({ screenX: 500, screenY: 300 }, win)).toBe(false);
    expect(droppedOutside({ screenX: 0, screenY: 0 }, win)).toBe(false);
  });
});

describe('withBounds', () => {
  const b = (n: number): Bounds => ({ left: n, top: n, width: 900, height: 600 });

  it('replaces a session position and keeps it the most recent', () => {
    expect(Object.keys(withBounds({ a: b(1), c: b(2) }, 'a', b(3)))).toEqual(['c', 'a']);
  });

  it('keeps at most fifty sessions, dropping the oldest', () => {
    let all: Record<string, Bounds> = {};
    for (let i = 0; i < 60; i++) all = withBounds(all, `s${i}`, b(i));
    const keys = Object.keys(all);
    expect(keys).toHaveLength(50);
    expect(keys[0]).toBe('s10');
    expect(keys.at(-1)).toBe('s59');
  });
});

describe('bringForward', () => {
  it('asks the desktop app to raise the window, then focuses it', () => {
    const calls: string[] = [];
    const known = { focus: () => calls.push('focus') } as unknown as Window;
    const w = { shellyardDesktop: { showWindow: vi.fn(), showDetached: (id: string) => calls.push(`raise ${id}`) } } as unknown as Window;
    bringForward(ID, known, w);
    expect(calls).toEqual([`raise ${ID}`, 'focus']);
  });

  it('still focuses the window in a browser, or with an app that lacks the call or fails', () => {
    for (const w of [{}, { shellyardDesktop: { showWindow: vi.fn() } }, { shellyardDesktop: { showWindow: vi.fn(), showDetached: () => { throw new Error('gone'); } } }]) {
      const focus = vi.fn();
      bringForward(ID, { focus } as unknown as Window, w as unknown as Window);
      expect(focus).toHaveBeenCalledOnce();
    }
  });
});

describe('the token handed to a new window', () => {
  it('goes in the fragment, which no server sees, and the session is still read from the address', () => {
    const url = detachedUrl(ID, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(url).toBe(`/?detached=${ID}#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    expect(detachedIdFrom(new URL(url, 'http://x').search)).toBe(ID);
    expect(detachedUrl(ID)).toBe(`/?detached=${ID}`);
  });
});

describe('the focused message', () => {
  it('is read with its state, and refused without one', () => {
    expect(parseMessage({ t: 'focused', id: ID, on: true })).toEqual({ t: 'focused', id: ID, on: true });
    expect(parseMessage({ t: 'focused', id: ID, on: false })).toEqual({ t: 'focused', id: ID, on: false });
    expect(parseMessage({ t: 'focused', id: ID })).toBeNull();
    expect(parseMessage({ t: 'focused', id: ID, on: 'yes' })).toBeNull();
    expect(parseMessage({ t: 'focused', id: 'nope', on: true })).toBeNull();
  });
});

describe('boundsToSave', () => {
  const area = { availWidth: 1920, availHeight: 1040 };
  const shown = { screenX: 100, screenY: 80, innerWidth: 900, innerHeight: 600, outerWidth: 916, outerHeight: 680, hidden: false };

  it('keeps the inner size, which window.open gives back, so the window does not grow', () => {
    expect(boundsToSave(shown, area)).toEqual({ left: 100, top: 80, width: 900, height: 600 });
  });

  it('keeps a place on a monitor left of or above the main one', () => {
    expect(boundsToSave({ ...shown, screenX: -1800, screenY: -200 }, area)).toEqual({ left: -1800, top: -200, width: 900, height: 600 });
  });

  it('keeps nothing of a minimised window', () => {
    expect(boundsToSave({ ...shown, hidden: true }, area)).toBeNull();
    expect(boundsToSave({ ...shown, screenX: -32000, screenY: -32000, innerWidth: 160, innerHeight: 0 }, area)).toBeNull();
  });

  it('keeps nothing of a maximised or full-screen window', () => {
    expect(boundsToSave({ ...shown, screenX: -8, screenY: -8, innerWidth: 1920, innerHeight: 1000, outerWidth: 1936, outerHeight: 1056 }, area)).toBeNull();
  });
});

describe('reach', () => {
  it("finds the session's window by its name", () => {
    const found = { location: { href: `http://x/?detached=${ID}` }, close: vi.fn() };
    const open = vi.fn(() => found);
    expect(reach(ID, { open } as unknown as Window)).toBe(found);
    expect(open).toHaveBeenCalledWith('', `shellyard-${ID}`);
    expect(found.close).not.toHaveBeenCalled();
  });

  it('closes a blank window it opened because none had the name, and gives null', () => {
    const blank = { location: { href: 'about:blank' }, close: vi.fn() };
    expect(reach(ID, { open: () => blank } as unknown as Window)).toBeNull();
    expect(blank.close).toHaveBeenCalled();
  });

  it('gives null when the window is refused (the desktop app) or the call fails', () => {
    expect(reach(ID, { open: () => null } as unknown as Window)).toBeNull();
    expect(reach(ID, { open: () => { throw new Error('blocked'); } } as unknown as Window)).toBeNull();
  });
});

describe('bringForward without a handle', () => {
  it('focuses the window found by name', () => {
    const focus = vi.fn();
    bringForward(ID, null, {} as Window, () => ({ focus }) as unknown as Window);
    expect(focus).toHaveBeenCalledOnce();
  });
});
