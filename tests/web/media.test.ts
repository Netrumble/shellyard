import { describe, expect, it, vi } from 'vitest';
import { onMediaChange } from '../../src/web/media.js';

describe('onMediaChange', () => {
  it('follows a query through addEventListener where there is one', () => {
    const list = { addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() };
    const cb = (): void => undefined;
    const stop = onMediaChange(list as unknown as MediaQueryList, cb);
    expect(list.addEventListener).toHaveBeenCalledWith('change', cb);
    stop();
    expect(list.removeEventListener).toHaveBeenCalledWith('change', cb);
    expect(list.addListener).not.toHaveBeenCalled();
  });

  it('falls back to addListener on a browser without it (Safari before 14)', () => {
    const list = { addListener: vi.fn(), removeListener: vi.fn() };
    const cb = (): void => undefined;
    const stop = onMediaChange(list as unknown as MediaQueryList, cb);
    expect(list.addListener).toHaveBeenCalledWith(cb);
    stop();
    expect(list.removeListener).toHaveBeenCalledWith(cb);
  });
});
