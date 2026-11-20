import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SoundFile, SoundSettings } from '../shared/types.js';
import { assertConfigWritable, dataDir, loadConfig, normalizeSoundSettings, saveConfig, SOUND_ID } from './config.js';
import type { StoryStore } from './stories.js';

// Sounds the user uploads to be played on events. Like background images they are kept in
// ShellYard's own folder under names ShellYard makes up; only the label is the user's.

export const MAX_SOUND_BYTES = 1024 * 1024;
const MAX_NAME = 80;
const TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' } as const;

/** What kind of sound some bytes are, judged by the bytes and not by a name or a header. */
export function soundKind(bytes: Buffer): { ext: 'mp3' | 'wav' | 'ogg'; type: string } | null {
  const text = (from: number, to: number): string => bytes.subarray(from, to).toString('latin1');
  if (bytes.length >= 4 && text(0, 4) === 'OggS') return { ext: 'ogg', type: TYPES.ogg };
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE') return { ext: 'wav', type: TYPES.wav };
  if (bytes.length >= 3 && text(0, 3) === 'ID3') return { ext: 'mp3', type: TYPES.mp3 };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return { ext: 'mp3', type: TYPES.mp3 };
  return null;
}

function folder(): string {
  const dir = join(dataDir(), 'sounds');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class SoundStore {
  constructor(private readonly stories: StoryStore) {}

  list(): SoundFile[] {
    return loadConfig().config.soundFiles;
  }

  settings(): SoundSettings {
    return loadConfig().config.sounds;
  }

  /** Saves an uploaded sound under the label given; null if the bytes are not audio ShellYard plays. */
  add(bytes: Buffer, name: string): SoundFile | null {
    if (bytes.length > MAX_SOUND_BYTES) return null;
    const kind = soundKind(bytes);
    if (!kind) return null;
    assertConfigWritable();
    const file: SoundFile = { id: `${randomUUID()}.${kind.ext}`, name: name.trim().slice(0, MAX_NAME) || 'sound' };
    writeFileSync(join(folder(), file.id), bytes);
    const { config } = loadConfig();
    saveConfig({ ...config, soundFiles: [...config.soundFiles, file] });
    return file;
  }

  read(id: string): { bytes: Buffer; type: string } | null {
    if (!SOUND_ID.test(id)) return null;
    const path = join(folder(), id);
    if (!existsSync(path)) return null;
    const ext = id.slice(id.lastIndexOf('.') + 1) as keyof typeof TYPES;
    return { bytes: readFileSync(path), type: TYPES[ext] };
  }

  /** Deletes the sound; settings and areas that used it fall back to none. */
  remove(id: string): boolean {
    if (!this.list().some((f) => f.id === id)) return false;
    assertConfigWritable();
    // Areas first, while the sound is still known: that is how their change is seen and sent.
    this.stories.clearSound(id);
    const { config } = loadConfig();
    const soundFiles = config.soundFiles.filter((f) => f.id !== id);
    saveConfig({ ...config, soundFiles, sounds: normalizeSoundSettings(config.sounds, soundFiles) });
    rmSync(join(folder(), id), { force: true });
    return true;
  }

  /** Unknown ids become null. */
  setSettings(s: unknown): SoundSettings {
    assertConfigWritable();
    const { config } = loadConfig();
    const sounds = normalizeSoundSettings(s, config.soundFiles);
    saveConfig({ ...config, sounds });
    return sounds;
  }
}
