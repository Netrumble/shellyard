import { describe, expect, it } from 'vitest';
import { initialState, reduce, type StatusEvent, type StatusState } from '../../src/server/state.js';

const idle: StatusState = { status: 'idle', reason: null };
const working: StatusState = { status: 'working', reason: null };
const blocked: StatusState = { status: 'attention', reason: 'blocked' };
const finished: StatusState = { status: 'attention', reason: 'finished' };
const maybe: StatusState = { status: 'attention', reason: 'maybe-waiting' };
const exited: StatusState = { status: 'exited', reason: null };
const live = [idle, working, blocked, finished, maybe];

describe('initialState', () => {
  it('starts a claude session idle', () => expect(initialState('claude')).toEqual(idle));
  it('starts a shell session running', () =>
    expect(initialState('shell')).toEqual({ status: 'running', reason: null }));
});

describe('reduce (claude)', () => {
  const table: Array<[string, StatusEvent, StatusState[], StatusState]> = [
    ['UserPromptSubmit', { type: 'hook', name: 'UserPromptSubmit' }, live, working],
    ['PreToolUse', { type: 'hook', name: 'PreToolUse' }, [idle, working, finished, maybe], working],
    ['PostToolUse', { type: 'hook', name: 'PostToolUse' }, [idle, working, finished, maybe], working],
    ['Notification', { type: 'hook', name: 'Notification', idleReminder: false }, live, blocked],
    ['PermissionRequest', { type: 'hook', name: 'PermissionRequest' }, live, blocked],
    ['idle reminder while working', { type: 'hook', name: 'Notification', idleReminder: true }, [working], blocked],
    ['Stop', { type: 'hook', name: 'Stop' }, live, finished],
    ['input on blocked', { type: 'input' }, [blocked], working],
    ['output on maybe-waiting', { type: 'output' }, [maybe], working],
    ['silence on working', { type: 'silence' }, [working], maybe],
    ['ack on finished', { type: 'ack' }, [finished], idle],
    ['exit', { type: 'exit' }, live, exited],
  ];
  for (const [label, event, froms, to] of table) {
    for (const from of froms) {
      it(`${label}: ${from.status}/${from.reason} -> ${to.status}/${to.reason}`, () => {
        expect(reduce('claude', from, event)).toEqual(to);
      });
    }
  }

  const unchanged: Array<[string, StatusEvent, StatusState[]]> = [
    ['input', { type: 'input' }, [idle, working, finished, maybe]],
    ['output', { type: 'output' }, [idle, working, blocked, finished]],
    ['silence', { type: 'silence' }, [idle, blocked, finished, maybe]],
    ['ack', { type: 'ack' }, [idle, working, blocked, maybe]],
    ['idle reminder', { type: 'hook', name: 'Notification', idleReminder: true }, [idle, blocked, finished, maybe]],
  ];
  for (const [label, event, froms] of unchanged) {
    for (const from of froms) {
      it(`${label} leaves ${from.status}/${from.reason} unchanged`, () => {
        expect(reduce('claude', from, event)).toEqual(from);
      });
    }
  }

  it('a tool hook from elsewhere in the same Claude does not hide a pending permission', () => {
    // Subagents and parallel tool calls keep reporting while the main prompt waits.
    expect(reduce('claude', blocked, { type: 'hook', name: 'PreToolUse' })).toEqual(blocked);
    expect(reduce('claude', blocked, { type: 'hook', name: 'PostToolUse' })).toEqual(blocked);
  });
  it('typing in a finished session does not hide it', () => {
    expect(reduce('claude', finished, { type: 'input' })).toEqual(finished);
  });
  it('an idle reminder does not resurface an acknowledged session', () => {
    expect(reduce('claude', idle, { type: 'hook', name: 'Notification', idleReminder: true })).toEqual(idle);
  });
  it('exited is terminal', () => {
    const events: StatusEvent[] = [
      { type: 'hook', name: 'Stop' },
      { type: 'hook', name: 'UserPromptSubmit' },
      { type: 'input' },
      { type: 'output' },
      { type: 'silence' },
      { type: 'ack' },
      { type: 'exit' },
    ];
    for (const e of events) expect(reduce('claude', exited, e)).toEqual(exited);
  });
});

describe('reduce (shell)', () => {
  const running: StatusState = { status: 'running', reason: null };
  it('a shell ignores everything but exit', () => {
    expect(reduce('shell', running, { type: 'silence' })).toEqual(running);
    expect(reduce('shell', running, { type: 'hook', name: 'Stop' })).toEqual(running);
    expect(reduce('shell', running, { type: 'input' })).toEqual(running);
  });
  it('a shell exits', () => {
    expect(reduce('shell', running, { type: 'exit' })).toEqual(exited);
  });
});
