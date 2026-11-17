import type { HookName, Reason, SessionKind, Status } from '../shared/types.js';

export interface StatusState {
  status: Status;
  reason: Reason;
}

export type StatusEvent =
  | { type: 'hook'; name: HookName; idleReminder?: boolean }
  | { type: 'input' }
  | { type: 'output' }
  | { type: 'silence' }
  | { type: 'ack' }
  | { type: 'exit' };

const WORKING: StatusState = { status: 'working', reason: null };
const EXITED: StatusState = { status: 'exited', reason: null };

export function initialState(kind: SessionKind): StatusState {
  return kind === 'claude' ? { status: 'idle', reason: null } : { status: 'running', reason: null };
}

/**
 * Pure status transition. Anything not handled returns the state unchanged, so an
 * unexpected event can never move a session out of "attention" by accident.
 */
export function reduce(kind: SessionKind, s: StatusState, e: StatusEvent): StatusState {
  if (s.status === 'exited') return s;
  if (e.type === 'exit') return EXITED;
  if (kind === 'shell') return s;

  switch (e.type) {
    case 'hook':
      switch (e.name) {
        case 'UserPromptSubmit':
          return WORKING;
        case 'PreToolUse':
        case 'PostToolUse':
          // Subagents and parallel tool calls keep reporting while the main prompt waits for
          // a permission. Only the user's answer (input), a new prompt or the end of the turn
          // may clear "blocked"; approval always arrives as input first.
          if (s.status === 'attention' && s.reason === 'blocked') return s;
          return WORKING;
        case 'Stop':
          return { status: 'attention', reason: 'finished' };
        case 'Notification':
          // An idle reminder only matters if we still believed Claude was working.
          if (e.idleReminder && s.status !== 'working') return s;
          return { status: 'attention', reason: 'blocked' };
      }
      return s;
    case 'input':
      return s.status === 'attention' && s.reason === 'blocked' ? WORKING : s;
    case 'output':
      return s.status === 'attention' && s.reason === 'maybe-waiting' ? WORKING : s;
    case 'silence':
      return s.status === 'working' ? { status: 'attention', reason: 'maybe-waiting' } : s;
    case 'ack':
      return s.status === 'attention' && s.reason === 'finished' ? { status: 'idle', reason: null } : s;
  }
}
