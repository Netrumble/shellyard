import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundFile, SoundLibrary } from '../../src/shared/types.js';

/** A request the test answers when it wants, to put answers out of order. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const sounds = vi.fn<() => Promise<SoundLibrary>>();
const trimSound = vi.fn<(id: string, trim: { start: number; end: number | null }) => Promise<SoundFile>>();
vi.mock('../../src/web/api.js', () => ({ api: { sounds, trimSound }, configureApi: vi.fn(), soundUrl: vi.fn() }));

const { getState, refreshSounds, saveSoundTrim } = await import('../../src/web/store.js');

const file = (start: number, end: number | null = null): SoundFile => ({ id: 'a.mp3', name: 'a', start, end });
const library = (f: SoundFile): SoundLibrary => ({ sounds: [f], settings: { blocked: null, finished: null, maybeWaiting: null } });
const held = (): SoundFile => getState().soundLibrary.sounds[0]!;

describe('the sound library and cut saves', () => {
  beforeEach(async () => {
    sounds.mockReset();
    trimSound.mockReset();
    sounds.mockResolvedValue(library(file(0)));
    await refreshSounds();
  });

  it('puts the saved sound into the library from the answer of the save', async () => {
    trimSound.mockResolvedValue(file(2));
    await saveSoundTrim('a.mp3', { start: 2, end: null });
    expect(held().start).toBe(2);
  });

  it('drops a library read that overlaps a save, as it may hold the older cut', async () => {
    const read = deferred<SoundLibrary>();
    sounds.mockReturnValueOnce(read.promise).mockResolvedValue(library(file(2)));
    const refreshing = refreshSounds();
    trimSound.mockResolvedValue(file(2));
    await saveSoundTrim('a.mp3', { start: 2, end: null });
    read.resolve(library(file(0)));
    await refreshing;
    expect(held().start).toBe(2);
    expect(sounds).toHaveBeenCalledTimes(3); // beforeEach, the dropped read, the read made again
  });

  it('reads the library again once a save that overlapped a read has answered', async () => {
    const read = deferred<SoundLibrary>();
    const save = deferred<SoundFile>();
    sounds.mockReturnValueOnce(read.promise).mockResolvedValue({ ...library(file(2)), settings: { blocked: 'a.mp3', finished: null, maybeWaiting: null } });
    trimSound.mockReturnValue(save.promise);
    const saving = saveSoundTrim('a.mp3', { start: 2, end: null });
    const refreshing = refreshSounds();
    read.resolve(library(file(0)));
    await refreshing;
    save.resolve(file(2));
    await saving;
    await vi.waitFor(() => expect(getState().soundLibrary.settings.blocked).toBe('a.mp3'));
    expect(held().start).toBe(2);
  });

  it('reads the library again when a read is dropped after the save it overlapped has answered', async () => {
    const read = deferred<SoundLibrary>();
    sounds.mockReturnValueOnce(read.promise).mockResolvedValue(library(file(2, 4)));
    const refreshing = refreshSounds();
    trimSound.mockResolvedValue(file(2));
    await saveSoundTrim('a.mp3', { start: 2, end: null });
    read.resolve(library(file(0)));
    await refreshing;
    await vi.waitFor(() => expect(held().end).toBe(4));
  });

  it('reads what the server keeps when the newest save of a sound fails', async () => {
    const first = deferred<SoundFile>();
    const second = deferred<SoundFile>();
    trimSound.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    sounds.mockResolvedValue(library(file(1)));
    const a = saveSoundTrim('a.mp3', { start: 1, end: null });
    const b = saveSoundTrim('a.mp3', { start: 2, end: null }).catch(() => 'failed');
    first.resolve(file(1));
    await a;
    second.reject(new Error('read-only'));
    expect(await b).toBe('failed');
    await vi.waitFor(() => expect(held().start).toBe(1));
  });

  it('drops a read that started while a save was on its way, even when the save answers first', async () => {
    const save = deferred<SoundFile>();
    const read = deferred<SoundLibrary>();
    trimSound.mockReturnValue(save.promise);
    sounds.mockReturnValueOnce(read.promise).mockResolvedValue(library(file(2)));
    const saving = saveSoundTrim('a.mp3', { start: 2, end: null });
    const refreshing = refreshSounds();
    save.resolve(file(2));
    await saving;
    read.resolve(library(file(0)));
    await refreshing;
    expect(held().start).toBe(2);
  });

  it('keeps the answer of the last save of a sound when answers come out of order', async () => {
    const first = deferred<SoundFile>();
    const second = deferred<SoundFile>();
    trimSound.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = saveSoundTrim('a.mp3', { start: 2, end: null });
    const b = saveSoundTrim('a.mp3', { start: 0, end: null });
    second.resolve(file(0));
    await b;
    first.resolve(file(2));
    await a;
    expect(held().start).toBe(0);
  });
});
