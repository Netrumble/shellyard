// Gives a prompt to a Claude Code session that has just been started, by typing it into its
// terminal. The prompt is not passed on the command line: there it would have to survive the
// quoting of cmd.exe, and it would be sent again each time the session is restored.
//
// Claude Code is ready for typing when it draws its main screen, and that is when it first
// runs its status line: the first status report of a session is the signal to type. That the
// prompt was taken is known from the UserPromptSubmit hook.

export type DeliveryOutcome = 'delivered' | 'undelivered';

interface Pending {
  prompt: string;
  done: (outcome: DeliveryOutcome, detail: string | null) => void;
  state: 'waiting' | 'ready' | 'pasted' | 'sent';
  /** When the current state was entered. */
  since: number;
}

const READY_TIMEOUT_MS = 120_000;
const CONFIRM_TIMEOUT_MS = 30_000;
/** Between the paste and Enter, so that Claude Code has taken the paste in as one piece. */
const ENTER_DELAY_MS = 400;

/**
 * The prompt as a bracketed paste, which a terminal program takes as text and not as keys:
 * its line breaks do not submit it. Control characters are removed, so that nothing in a
 * prompt can end the paste early or act as a key press.
 */
export function pasteOf(prompt: string): string {
  // eslint-disable-next-line no-control-regex
  const text = prompt.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  return `\x1b[200~${text}\x1b[201~`;
}

export class PromptDelivery {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: { now: () => number; write: (sessionId: string, data: string) => void; alive: (sessionId: string) => boolean }) {}

  /** Asks for `prompt` to be typed into the session once it is ready; `done` is called once. */
  expect(sessionId: string, prompt: string, done: (outcome: DeliveryOutcome, detail: string | null) => void): void {
    this.pending.set(sessionId, { prompt, done, state: 'waiting', since: this.deps.now() });
  }

  /** The session has reported a status line: its main screen is up. */
  ready(sessionId: string): void {
    const p = this.pending.get(sessionId);
    if (p?.state === 'waiting') this.move(p, 'ready');
  }

  /** Claude Code has taken a prompt in this session. */
  submitted(sessionId: string): void {
    const p = this.pending.get(sessionId);
    // Before ours was sent, it is one the user typed; ours is still to come.
    if (p?.state !== 'sent') return;
    this.finish(sessionId, p, 'delivered', null);
  }

  private move(p: Pending, state: Pending['state']): void {
    p.state = state;
    p.since = this.deps.now();
  }

  private finish(sessionId: string, p: Pending, outcome: DeliveryOutcome, detail: string | null): void {
    this.pending.delete(sessionId);
    p.done(outcome, detail);
  }

  /** Moves every delivery on; called a few times a second. */
  tick(): void {
    const now = this.deps.now();
    for (const [sessionId, p] of [...this.pending]) {
      if (!this.deps.alive(sessionId)) {
        const typed = p.state === 'pasted' || p.state === 'sent';
        this.finish(sessionId, p, 'undelivered', typed ? 'The session ended before Claude Code confirmed the prompt.' : 'The session ended before the prompt could be typed.');
        continue;
      }
      const waited = now - p.since;
      if (p.state === 'waiting' && waited > READY_TIMEOUT_MS) {
        this.finish(sessionId, p, 'undelivered', 'Claude Code did not become ready within 2 minutes; the prompt was not typed.');
      } else if (p.state === 'ready') {
        this.deps.write(sessionId, pasteOf(p.prompt));
        this.move(p, 'pasted');
      } else if (p.state === 'pasted' && waited >= ENTER_DELAY_MS) {
        this.deps.write(sessionId, '\r');
        this.move(p, 'sent');
      } else if (p.state === 'sent' && waited > CONFIRM_TIMEOUT_MS) {
        this.finish(sessionId, p, 'undelivered', 'The prompt was typed, but Claude Code did not confirm it took it.');
      }
    }
  }
}
