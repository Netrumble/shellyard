import type { SessionInfo, SoundSettings, Story } from '../shared/types.js';
import { soundUrl } from './api.js';
import { chime } from './sound.js';

export type SoundEvent = 'blocked' | 'finished' | 'maybeWaiting';

const urgency: SoundEvent[] = ['blocked', 'finished', 'maybeWaiting'];

export function eventOf(s: SessionInfo): SoundEvent {
  if (s.reason === 'blocked') return 'blocked';
  if (s.reason === 'finished') return 'finished';
  return 'maybeWaiting';
}

/**
 * The one sound for a batch of sessions that started waiting: that of the most urgent one
 * (first in the list on a tie). Its area's sound wins over the sound of the event.
 * Undefined: nothing is waiting; null: the chime; a string: a sound id.
 */
export function pickSound(waiting: SessionInfo[], stories: Story[], settings: SoundSettings): string | null | undefined {
  let best: SessionInfo | undefined;
  for (const s of waiting) if (!best || urgency.indexOf(eventOf(s)) < urgency.indexOf(eventOf(best))) best = s;
  if (!best) return undefined;
  const own = stories.find((x) => x.id === best!.storyId)?.sound;
  return own ? own : settings[eventOf(best)];
}

/** A page that has the focus is being looked at; it stays silent. */
export function shouldPlay(hasFocus: boolean, soundOn: boolean): boolean {
  return soundOn && !hasFocus;
}

/** Plays a stored sound, or the chime for null; any failure falls back to the chime. */
export async function playSound(id: string | null): Promise<void> {
  if (id === null) return chime();
  try {
    await new Audio(await soundUrl(id)).play();
  } catch {
    chime();
  }
}
