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
  it('does not chime when the sound plays', async () => {
    soundUrl.mockResolvedValue('blob:x');
    vi.stubGlobal('Audio', class { play = () => Promise.resolve(); });
    await playSound('x');
    expect(chime).not.toHaveBeenCalled();
  });
});
