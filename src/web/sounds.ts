import type { SessionInfo, SoundFile, SoundSettings, Story } from '../shared/types.js';
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

/** A start at or past the end of the file would play nothing. */
function pastEnd(start: number, duration: number): Error | null {
  return start < duration ? null : new Error(`The cut starts at ${start} s, but the sound lasts ${duration} s.`);
}

/**
 * Pauses the sound when playback reaches `end`, going by where it is rather than by the clock:
 * each `timeupdate` aims a timer at what is left, so a stall while buffering moves the stop with it.
 */
function stopAt(audio: HTMLAudioElement, end: number): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (): void => {
    clearTimeout(timer);
    audio.removeEventListener('timeupdate', aim);
    audio.removeEventListener('pause', done);
    audio.removeEventListener('ended', done);
  };
  function aim(): void {
    clearTimeout(timer);
    const left = end - audio.currentTime;
    if (left <= 0) {
      done();
      audio.pause();
      return;
    }
    timer = setTimeout(aim, Math.ceil(left * 1000));
  }
  audio.addEventListener('timeupdate', aim);
  audio.addEventListener('pause', done);
  audio.addEventListener('ended', done);
  aim();
}

/**
 * Plays a stored sound, or the chime for null; any failure falls back to the chime, once.
 * `files` gives the sound's cut: it plays from its start and stops at its end. A cut that
 * starts at or past the end of the file would play nothing, so the chime plays instead.
 * Never muted: a browser that refuses to play refuses play() itself, and the chime plays.
 */
export async function playSound(id: string | null, files: SoundFile[] = []): Promise<void> {
  if (id === null) return chime();
  const file = files.find((f) => f.id === id);
  let fellBack = false;
  const fallBack = (e: unknown): void => {
    if (fellBack) return;
    fellBack = true;
    console.warn('ShellYard: could not play the sound, playing the chime instead.', e);
    chime();
  };
  try {
    const audio = new Audio(await soundUrl(id));
    if (file && file.start > 0) {
      const start = file.start;
      // A new element has not loaded yet, and play() is not delayed for it (a click lets a page start
      // audio only for a short while). Set before loading, currentTime is where playing starts once
      // loaded; a browser that refuses or drops it gets it again when the length is known. The
      // length also tells whether the cut can play at all.
      try {
        audio.currentTime = start;
      } catch {
        // Set again below.
      }
      audio.addEventListener(
        'loadedmetadata',
        () => {
          const err = pastEnd(start, audio.duration);
          if (err) {
            audio.pause();
            fallBack(err);
          } else if (audio.currentTime < start) audio.currentTime = start;
        },
        { once: true },
      );
    }
    await audio.play();
    if (file && file.end !== null) stopAt(audio, file.end);
  } catch (e) {
    fallBack(e);
  }
}
