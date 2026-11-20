import type { SessionInfo } from './types.js';

/** Why a session cannot be given a prompt now, or null when it can. */
export type PromptRefusal = 'not-claude' | 'busy' | 'exited';

/**
 * Whether a prompt can be typed into a session now: a Claude Code session waiting at its prompt
 * (idle, or finished its turn). Never one blocked on a question or a permission, where the text
 * would land in the menu, nor one at work, nor a shell.
 */
export function promptRefusal(s: SessionInfo): PromptRefusal | null {
  if (s.kind !== 'claude') return 'not-claude';
  if (s.status === 'exited') return 'exited';
  if (s.status === 'idle' || (s.status === 'attention' && s.reason === 'finished')) return null;
  return 'busy';
}

/** The most a prompt sent to several sessions may hold. */
export const MAX_PROMPT = 20_000;
