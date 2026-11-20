import type { SessionInfo } from '../shared/types.js';

/** What a waiting session wants, as the board and the answer queue show it. */
export type RequestKind = 'permission' | 'question' | 'maybe' | 'finished';

/** Meant for a session that waits (status "attention"). */
export function requestKind(s: SessionInfo): RequestKind {
  if (s.reason === 'finished') return 'finished';
  if (s.reason === 'maybe-waiting') return 'maybe';
  return s.pending?.kind === 'question' ? 'question' : 'permission';
}

export const REQUEST_BADGE: Record<RequestKind, string> = {
  permission: 'Permission',
  question: 'Question',
  maybe: 'Possibly waiting',
  finished: 'Finished',
};

/** Whether the request on screen can be allowed or denied from outside the terminal. */
export function answerable(s: SessionInfo): boolean {
  return s.status === 'attention' && s.reason === 'blocked' && s.pending?.kind === 'permission';
}

/** "Allow this command in C:\repos\hcm?": what the terminal asks, in a line. */
export function askLine(s: SessionInfo): string {
  const tool = s.pending?.tool;
  const what = tool === 'Bash' ? 'this command' : tool ? `${tool} here` : 'this';
  return `Allow ${what} in ${s.liveCwd ?? s.cwd}?`;
}

/** The short line under a name in the queue: "Permission · dotnet test", "Question · Which version?". */
export function requestSummary(s: SessionInfo): string {
  const kind = requestKind(s);
  const p = s.pending;
  const what = kind === 'permission' || kind === 'question' ? (p?.detail ?? p?.message ?? null) : null;
  return what ? `${REQUEST_BADGE[kind]} · ${what}` : REQUEST_BADGE[kind];
}
