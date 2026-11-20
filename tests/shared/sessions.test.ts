import { describe, expect, it } from 'vitest';
import { promptRefusal } from '../../src/shared/sessions.js';
import { session } from '../web/session-fixture.js';

describe('promptRefusal', () => {
  it('takes a prompt in a Claude session that waits at its prompt', () => {
    expect(promptRefusal(session('a', 'idle'))).toBeNull();
    expect(promptRefusal(session('a', 'attention', 'finished'))).toBeNull();
  });

  it('refuses a session at work, or blocked on a question or a permission', () => {
    expect(promptRefusal(session('a', 'working'))).toBe('busy');
    expect(promptRefusal(session('a', 'attention', 'blocked'))).toBe('busy');
    expect(promptRefusal(session('a', 'attention', 'maybe-waiting'))).toBe('busy');
  });

  it('refuses shells and ended sessions', () => {
    expect(promptRefusal(session('s', 'running', null, 0, 'shell'))).toBe('not-claude');
    expect(promptRefusal(session('x', 'exited'))).toBe('exited');
  });
});
