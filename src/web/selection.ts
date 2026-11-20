// Several sessions picked on the board, for one action on all of them.

/** Adds a session to the end of the selection, or takes it out. */
export function toggleSelected(selection: string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
}

/** The selection without the sessions that are gone; the same list when none is. */
export function pruneSelection(selection: string[], existing: ReadonlySet<string>): string[] {
  return selection.every((id) => existing.has(id)) ? selection : selection.filter((id) => existing.has(id));
}

/** A click that picks a session instead of opening it: with Shift, Ctrl or Cmd (Alt is left to the system). */
export function isSelectGesture(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return !e.altKey && (e.shiftKey || e.ctrlKey || e.metaKey);
}

export type SendOutcome = 'sent' | 'busy' | 'starting' | 'not-claude' | 'exited' | 'missing';

/** Why a session did not take the prompt; "sent" and "missing" are worded where they are used. */
const WHY: Record<SendOutcome, string> = {
  sent: 'sent',
  missing: 'closed',
  busy: 'busy: it is working or waiting on a question',
  starting: 'still starting: try again in a moment',
  'not-claude': 'not a Claude Code session',
  exited: 'it has ended',
};

/** One line on a prompt sent to several sessions: how many took it, and which did not and why. */
export function sendReport(results: Array<{ id: string; outcome: SendOutcome }>, names: ReadonlyMap<string, string>): string {
  const sent = results.filter((r) => r.outcome === 'sent').length;
  const failed = results.filter((r) => r.outcome !== 'sent');
  if (failed.length === 0) return `Sent to ${sent} session${sent === 1 ? '' : 's'}.`;
  const reasons = failed.map((r) => (r.outcome === 'missing' ? 'a closed session' : `${names.get(r.id) ?? 'a session'} (${WHY[r.outcome]})`));
  return `Sent to ${sent} of ${results.length}. Not sent: ${reasons.join(', ')}.`;
}
