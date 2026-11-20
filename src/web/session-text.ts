import type { SessionInfo } from '../shared/types.js';
import { glyphOf, type Glyph } from './status-glyph.js';

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const capital = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** "claude-opus-5-5" as "Opus 5.5"; an alias capitalised; anything else as it is. */
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  const bare = model.replace(/\[[^\]]*\]$/, '').trim();
  const id = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(bare);
  if (id && FAMILIES.includes(id[1]!.toLowerCase())) return `${capital(id[1]!.toLowerCase())} ${id[2]}${id[3] ? `.${id[3]}` : ''}`;
  if (FAMILIES.includes(bare.toLowerCase())) return capital(bare.toLowerCase());
  return bare;
}

/** One unit, the largest that fits: "40s", "4m", "2h", "3d". */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** How long a request has waited, as a stopwatch shows it: "04:12", "1:01:01". */
export function waitClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const rest = `${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return h > 0 ? `${h}:${rest}` : rest;
}

const DOING: Record<Glyph, string> = {
  needs: 'Waiting for you',
  maybe: 'Possibly waiting',
  working: 'Working',
  finished: 'Finished',
  idle: 'Idle',
  exited: 'Exited',
};

/** The program a shell runs, without folder or extension: "pwsh", "bash". */
function programOf(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

/** The second line of a session row: what it does, then the model, the program or what went wrong. */
export function sessionLine(s: SessionInfo, rate: number): string {
  const doing = DOING[glyphOf(s, rate)];
  const extra = s.error ?? (s.kind === 'claude' ? modelLabel(s.model) : programOf(s.command) || null);
  return extra ? `${doing} · ${extra}` : doing;
}
