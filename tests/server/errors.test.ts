import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorReporter, errorParts, redact, revealCommand } from '../../src/server/errors.js';
import { removeDir } from '../helpers.js';

const TOKEN = 'a'.repeat(64);
const HOOK = 'b1'.repeat(32);

describe('redact', () => {
  it('takes out the secrets given and anything that looks like a token', () => {
    const other = 'c0ffee'.repeat(10) + 'abcd';
    expect(redact(`token ${TOKEN}, host myhostlabel.localhost, other ${other}`, [TOKEN, 'myhostlabel'])).toBe('token [redacted], host [redacted].localhost, other [redacted]');
  });
  it('takes out a page host name even when no secret is given', () => {
    const label = '0123456789abcdef'.repeat(2);
    expect(redact(`listening, page on http://${label}.localhost:7717`, [])).toBe('listening, page on http://[redacted].localhost:7717');
    // Hex of that length elsewhere is left alone: a commit, a hash in a path.
    expect(redact(`commit ${label}`, [])).toBe(`commit ${label}`);
  });
  it('leaves short secrets alone, as they would match ordinary words', () => {
    expect(redact('a short one', ['short'])).toBe('a short one');
  });
});

describe('errorParts', () => {
  it('reads an Error, a string and anything else', () => {
    const e = new TypeError('bad\nsecond line');
    expect(errorParts(e)).toEqual({ message: 'TypeError: bad', stack: e.stack });
    expect(errorParts('plain')).toEqual({ message: 'plain', stack: null });
    expect(errorParts({ code: 7 })).toEqual({ message: '{"code":7}', stack: null });
  });
});

describe('ErrorReporter', () => {
  let dir = '';
  let now = 1_700_000_000_000;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shellyard-errors-'));
    now = 1_700_000_000_000;
  });
  afterEach(() => removeDir(dir));

  const reporter = (extra: Partial<ConstructorParameters<typeof ErrorReporter>[0]> = {}) =>
    new ErrorReporter({ dir, now: () => now, version: '9.9.9', secrets: () => [TOKEN, HOOK], logTail: () => `log line with ${TOKEN}`, ...extra });

  it('writes a report with what is needed to understand the error, and no secret', () => {
    const r = reporter().report({ source: 'server', error: new Error(`failed with ${TOKEN}`), context: `POST /api/x ${HOOK}` })!;
    expect(r).toMatchObject({ source: 'server', message: 'Error: failed with [redacted]', context: 'POST /api/x [redacted]', count: 1, seen: false });
    expect(r.file.startsWith(dir)).toBe(true);
    const text = readFileSync(r.file, 'utf8');
    expect(text).toContain('Where:    server');
    expect(text).toContain('ShellYard 9.9.9');
    expect(text).toContain('Stack:');
    expect(text).toContain('Last lines of shellyard.log:');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HOOK);
    if (process.platform !== 'win32') expect(statSync(r.file).mode & 0o777).toBe(0o600);
  });

  it('counts the same error again in the same file, and shows it again', () => {
    const rep = reporter();
    // Thrown from the same place, as a repeated error is.
    const boom = (): Error => new Error('same');
    const first = rep.report({ source: 'server', error: boom(), context: 'x' })!;
    rep.dismiss(first.id);
    now += 5000;
    const again = rep.report({ source: 'server', error: boom(), context: 'x' })!;
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ count: 2, seen: false, lastAt: now });
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readFileSync(first.file, 'utf8')).toContain('Again at');
  });

  it('tells its listeners of repetitions at most once every so often', () => {
    vi.useFakeTimers();
    try {
      const rep = reporter({ repeatEmitMs: 5000 });
      const counts: number[] = [];
      rep.onChange((l) => counts.push(l[0]!.count));
      const boom = (): Error => new Error('again and again');
      rep.report({ source: 'server', error: boom() });
      // Once a second for ten seconds.
      for (let i = 0; i < 10; i++) {
        now += 1000;
        vi.advanceTimersByTime(1000);
        rep.report({ source: 'server', error: boom() });
      }
      vi.advanceTimersByTime(5000);
      expect(counts).toEqual([1, 5, 10, 11]);
      // Every repetition is still counted and noted in the file.
      expect(rep.list()[0]!.count).toBe(11);
      expect(readFileSync(rep.list()[0]!.file, 'utf8').match(/Again at/g)).toHaveLength(10);
      // After a quiet spell, a repetition is told at once.
      now += 60_000;
      vi.advanceTimersByTime(60_000);
      rep.report({ source: 'server', error: boom() });
      expect(counts).toEqual([1, 5, 10, 11, 12]);
      rep.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a new report for another error, newest first', () => {
    const rep = reporter();
    rep.report({ source: 'server', error: new Error('one') });
    now += 1;
    rep.report({ source: 'page', error: 'two', stack: 'from the page' });
    expect(rep.list().map((r) => r.message)).toEqual(['two', 'Error: one']);
    expect(readFileSync(rep.list()[0]!.file, 'utf8')).toContain('from the page');
  });

  it('writes no more than so many new reports a minute', () => {
    const rep = reporter({ perMinute: 2 });
    expect(rep.report({ source: 'server', error: 'a' })).not.toBeNull();
    expect(rep.report({ source: 'server', error: 'b' })).not.toBeNull();
    expect(rep.report({ source: 'server', error: 'c' })).toBeNull();
    now += 61_000;
    expect(rep.report({ source: 'server', error: 'd' })).not.toBeNull();
  });

  it('keeps only the newest files', () => {
    writeFileSync(join(dir, '2000-01-01T00-00-00-000Z-old.log'), 'old');
    const rep = reporter({ keep: 2 });
    rep.report({ source: 'server', error: 'a' });
    now += 1000;
    rep.report({ source: 'server', error: 'b' });
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes('old'))).toBe(false);
  });

  it('marks reports as seen, and tells its listeners', () => {
    const rep = reporter();
    const seen: number[] = [];
    rep.onChange((l) => seen.push(l.filter((r) => !r.seen).length));
    const a = rep.report({ source: 'server', error: 'a' })!;
    rep.report({ source: 'server', error: 'b' });
    expect(rep.dismiss(a.id)).toBe(true);
    expect(rep.dismiss('nope')).toBe(false);
    rep.dismissAll();
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  it('gives null, and throws nothing, when the folder cannot be written', () => {
    const file = join(dir, 'not-a-folder');
    writeFileSync(file, 'x');
    const rep = new ErrorReporter({ dir: join(file, 'errors'), now: () => now, version: '1' });
    expect(rep.report({ source: 'server', error: 'x' })).toBeNull();
    expect(rep.list()).toEqual([]);
  });
});

describe('revealCommand', () => {
  it('selects the file in Finder and Explorer, and opens its folder elsewhere', () => {
    expect(revealCommand('/u/e/r.log', 'darwin')).toEqual({ file: '/usr/bin/open', args: ['-R', '/u/e/r.log'], verbatim: false });
    expect(revealCommand('C:\\Users\\me\\.shellyard\\errors\\r.log', 'win32', { SystemRoot: 'D:\\Win' })).toEqual({
      file: 'D:\\Win\\explorer.exe',
      args: ['/select,"C:\\Users\\me\\.shellyard\\errors\\r.log"'],
      verbatim: true,
    });
    expect(revealCommand('/u/e/r.log', 'linux')).toEqual({ file: 'xdg-open', args: ['/u/e'], verbatim: false });
  });
});
