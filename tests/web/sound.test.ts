import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSound } from '../../src/web/effects.js';
import { notify } from '../../src/web/notify.js';
import type { SessionInfo } from '../../src/shared/types.js';

describe('the Sound setting', () => {
  it('is on until the user switches it off', () => {
    expect(resolveSound(null)).toBe(true);
    expect(resolveSound('on')).toBe(true);
    expect(resolveSound('off')).toBe(false);
    expect(resolveSound('anything else')).toBe(true);
  });
});

describe('system notifications', () => {
  afterEach(() => vi.unstubAllGlobals());

  const session = { id: 's1', name: 'review', status: 'attention', reason: 'blocked' } as SessionInfo;
  function stub(): Array<{ title: string; options: NotificationOptions }> {
    const shown: Array<{ title: string; options: NotificationOptions }> = [];
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) {
        shown.push({ title, options });
      }
      close(): void {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('document', { hasFocus: () => false });
    return shown;
  }

  it('make no sound when Sound is off', () => {
    const shown = stub();
    notify(session, () => undefined, false);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.options.silent).toBe(true);
  });

  it('may make the system sound when Sound is on', () => {
    const shown = stub();
    notify(session, () => undefined, true);
    expect(shown[0]!.options.silent).toBe(false);
  });
});
