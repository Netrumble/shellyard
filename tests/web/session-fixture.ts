import type { Reason, SessionInfo, Status } from '../../src/shared/types.js';

/** A session as the server would send it, with everything but its id, state and kind at a default. */
export function session(id: string, status: Status, reason: Reason = null, statusSince = 0, kind: 'claude' | 'shell' = 'claude'): SessionInfo {
  return { id, kind, storyId: null, name: id, color: '#888888', cwd: '/', command: 'x', args: [], model: null, status, reason, statusSince, cols: 80, rows: 24, exitCode: null, error: null, resumed: false, background: null, font: null, git: null, liveCwd: null };
}
