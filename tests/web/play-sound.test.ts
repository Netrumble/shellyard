import { afterEach, describe, expect, it, vi } from 'vitest';

const chime = vi.fn();
const soundUrl = vi.fn();
vi.mock('../../src/web/sound.js', () => ({ chime }));
vi.mock('../../src/web/api.js', () => ({ soundUrl }));

const { playSound } = await import('../../src/web/sounds.js');

afterEach(() => {
  vi.unstubAllGlobals();
  chime.mockReset();
  soundUrl.mockReset();
});

describe('playSound', () => {
  it('plays the chime for null', async () => {
    await playSound(null);
    expect(chime).toHaveBeenCalledOnce();
  });
  it('falls back to the chime when the sound cannot be loaded', async () => {
    soundUrl.mockRejectedValue(new Error('gone'));
    await playSound('x');
    expect(chime).toHaveBeenCalledOnce();
  });
  it('falls back to the chime when the sound cannot be played', async () => {
    soundUrl.mockResolvedValue('blob:x');
    vi.stubGlobal('Audio', class { play = () => Promise.reject(new Error('blocked')); });
    await playSound('x');
    expect(chime).toHaveBeenCalledOnce();
  });
  /** An audio element whose metadata loads when told to, and whose position the test moves. */
  class FakeAudio extends EventTarget {
    static made: FakeAudio[] = [];
    readyState = 0;
    duration = Number.NaN;
    currentTime = 0;
    paused = true;
    muted = false;
    constructor() {
      super();
      FakeAudio.made.push(this);
    }
    loaded(duration: number): void {
      this.readyState = 1;
      this.duration = duration;
      this.dispatchEvent(new Event('loadedmetadata'));
    }
    play = (): Promise<void> => {
      this.paused = false;
      return Promise.resolve();
    };
    pause = (): void => {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    };
  }

  it('moves to the cut once the length is known when the browser refuses an early start', async () => {
    FakeAudio.made = [];
    soundUrl.mockResolvedValue('blob:x');
    /** Refuses a position before it has loaded, as some browsers have. */
    class StrictAudio extends FakeAudio {
      constructor() {
        super();
        let at = 0;
        Object.defineProperty(this, 'currentTime', {
          get: () => at,
          set: (t: number) => {
            if (this.readyState === 0) throw new Error('InvalidStateError');
            at = t;
          },
        });
      }
    }
    vi.stubGlobal('Audio', StrictAudio);
    await playSound('x', [{ id: 'x', name: 'x', start: 1.5, end: null }]);
    const audio = FakeAudio.made[0]!;
    expect(audio.paused).toBe(false);
    audio.loaded(3);
    expect(audio.currentTime).toBe(1.5);
    expect(chime).not.toHaveBeenCalled();
  });
  it('moves to the cut once the length is known when the browser drops an early start', async () => {
    FakeAudio.made = [];
    soundUrl.mockResolvedValue('blob:x');
    /** Takes a position before it has loaded, then forgets it, as older WebKit has. */
    class ForgetfulAudio extends FakeAudio {
      loaded(duration: number): void {
        this.currentTime = 0;
        super.loaded(duration);
      }
    }
    vi.stubGlobal('Audio', ForgetfulAudio);
    await playSound('x', [{ id: 'x', name: 'x', start: 1.5, end: null }]);
    const audio = FakeAudio.made[0]!;
    audio.loaded(3);
    expect(audio.currentTime).toBe(1.5);
    expect(chime).not.toHaveBeenCalled();
  });
  it('plays at once from the start of the cut when the length is not known yet', async () => {
    FakeAudio.made = [];
    soundUrl.mockResolvedValue('blob:x');
    vi.stubGlobal('Audio', FakeAudio);
    await playSound('x', [{ id: 'x', name: 'x', start: 1, end: null }]);
    const audio = FakeAudio.made[0]!;
    expect(audio.currentTime).toBe(1);
    expect(audio.paused).toBe(false);
    audio.loaded(3);
    expect(audio.paused).toBe(false);
    expect(chime).not.toHaveBeenCalled();
  });
  it('stops and chimes once when the length, known late, is shorter than the start of the cut', async () => {
    FakeAudio.made = [];
    soundUrl.mockResolvedValue('blob:x');
    vi.stubGlobal('Audio', FakeAudio);
    await playSound('x', [{ id: 'x', name: 'x', start: 5, end: null }]);
    FakeAudio.made[0]!.loaded(2);
    expect(FakeAudio.made[0]!.paused).toBe(true);
    expect(chime).toHaveBeenCalledOnce();
  });
  it('chimes once when the length arrives during play() and pausing makes play() fail', async () => {
    FakeAudio.made = [];
    soundUrl.mockResolvedValue('blob:x');
    class SlowAudio extends FakeAudio {
      private reject: ((e: Error) => void) | null = null;
      play = (): Promise<void> => new Promise<void>((_, reject) => (this.reject = reject));
      pause = (): void => {
        this.paused = true;
        this.reject?.(new Error('AbortError'));
      };
    }
    vi.stubGlobal('Audio', SlowAudio);
    const playing = playSound('x', [{ id: 'x', name: 'x', start: 5, end: null }]);
    await vi.waitFor(() => expect(FakeAudio.made).toHaveLength(1));
    FakeAudio.made[0]!.loaded(2);
    await playing;
    expect(chime).toHaveBeenCalledOnce();
  });
  it('stops at the end of the cut by where playback is, not by the clock', async () => {
    vi.useFakeTimers();
    FakeAudio.made = [];
    soundUrl.mockResolvedValue('blob:x');
    vi.stubGlobal('Audio', FakeAudio);
    const playing = playSound('x', [{ id: 'x', name: 'x', start: 0, end: 2 }]);
    await vi.waitFor(() => expect(FakeAudio.made).toHaveLength(1));
    await playing;
    const audio = FakeAudio.made[0]!;
    // A stall: after 2 s on the clock, playback is only at 1.7 s.
    audio.currentTime = 1.7;
    vi.advanceTimersByTime(2000);
    expect(audio.paused).toBe(false);
    audio.currentTime = 2;
    vi.advanceTimersByTime(300);
    expect(audio.paused).toBe(true);
    vi.useRealTimers();
  });
  it('does not chime when the sound plays', async () => {
    soundUrl.mockResolvedValue('blob:x');
    vi.stubGlobal('Audio', class { play = () => Promise.resolve(); });
    await playSound('x');
    expect(chime).not.toHaveBeenCalled();
  });
});
