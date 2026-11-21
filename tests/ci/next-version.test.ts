import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript script of the workflow, without types
import { nextVersion } from '../../.github/scripts/next-version.mjs';

describe('nextVersion', () => {
  it('gives one more than the highest patch of the same major and minor', () => {
    expect(nextVersion('0.2.0', ['v0.2.0'])).toBe('0.2.1');
    expect(nextVersion('0.2.0', ['v0.2.0', 'v0.2.7', 'v0.2.3', 'v0.1.9'])).toBe('0.2.8');
  });

  it('compares patches as numbers, and accepts tags without "v"', () => {
    expect(nextVersion('0.2.0', ['v0.2.9', '0.2.10'])).toBe('0.2.11');
  });

  it('starts at patch 0 when the major and minor have no release yet', () => {
    expect(nextVersion('0.3.0', ['v0.2.5', 'v1.3.0'])).toBe('0.3.0');
    expect(nextVersion('0.3.0', [])).toBe('0.3.0');
  });

  it('ignores pre-releases and other tags', () => {
    expect(nextVersion('0.2.0', ['v0.2.1', 'v0.2.5-beta', 'nightly', 'v0.20.4'])).toBe('0.2.2');
  });

  it('takes only major and minor of the base', () => {
    expect(nextVersion('0.2.4', ['v0.2.0'])).toBe('0.2.1');
  });

  it('refuses a base that is not a version', () => {
    expect(() => nextVersion('0.2', [])).toThrow(/major.minor.patch/);
  });

  it('reads the tags on stdin when run as a script', () => {
    const script = join(__dirname, '..', '..', '.github', 'scripts', 'next-version.mjs');
    expect(execFileSync(process.execPath, [script, '0.2.0'], { input: 'v0.2.0\nv0.2.1\n', encoding: 'utf8' })).toBe('0.2.2\n');
  });
});
