import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmShared } from '../../src/web/components/WorktreeChip.js';
import type { SessionInfo } from '../../src/shared/types.js';

const named = (name: string): SessionInfo => ({ id: name, name }) as unknown as SessionInfo;

describe('confirmShared', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not ask when no other session works there', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', { confirm });
    expect(confirmShared([], 'Move "x"')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('names the other sessions and returns the answer', () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('window', { confirm });
    expect(confirmShared([named('a'), named('b')], 'Switch the branch of app')).toBe(true);
    expect(confirm).toHaveBeenCalledWith('Switch the branch of app? These sessions are also working in this worktree: a, b. Continue anyway?');
  });

  it('returns false when the answer is no', () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => false) });
    expect(confirmShared([named('a')], 'Move "x"')).toBe(false);
  });
});
