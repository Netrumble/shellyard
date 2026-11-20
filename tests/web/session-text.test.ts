import { describe, expect, it } from 'vitest';
import { modelLabel, sessionLine, shortAge, waitClock } from '../../src/web/session-text.js';
import { session } from './session-fixture.js';

describe('modelLabel', () => {
  it('turns a model id into its family and version', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2');
    expect(modelLabel('claude-opus-4')).toBe('Opus 4');
  });

  it('capitalises an alias and leaves anything else as it is', () => {
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('Opus 5.5')).toBe('Opus 5.5');
    expect(modelLabel('gpt-x')).toBe('gpt-x');
    expect(modelLabel(null)).toBeNull();
    expect(modelLabel('')).toBeNull();
  });
});

describe('shortAge', () => {
  it('says one unit, the largest that fits', () => {
    expect(shortAge(0)).toBe('0s');
    expect(shortAge(40_000)).toBe('40s');
    expect(shortAge(4 * 60_000 + 59_000)).toBe('4m');
    expect(shortAge(2 * 3_600_000 + 5 * 60_000)).toBe('2h');
    expect(shortAge(3 * 86_400_000)).toBe('3d');
    expect(shortAge(-5)).toBe('0s');
  });
});

describe('waitClock', () => {
  it('reads like a stopwatch', () => {
    expect(waitClock(0)).toBe('00:00');
    expect(waitClock(4 * 60_000 + 12_000)).toBe('04:12');
    expect(waitClock(3_600_000 + 61_000)).toBe('1:01:01');
    expect(waitClock(-1)).toBe('00:00');
  });
});

describe('sessionLine', () => {
  it('says what the session does and with which model', () => {
    expect(sessionLine({ ...session('a', 'attention', 'blocked'), model: 'claude-opus-5-5' }, 0)).toBe('Waiting for you · Opus 5.5');
    expect(sessionLine(session('a', 'working'), 0)).toBe('Working');
    expect(sessionLine(session('a', 'attention', 'finished'), 0)).toBe('Finished');
  });

  it('names the program of a shell', () => {
    const shell = { ...session('s', 'running', null, 0, 'shell'), command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' };
    expect(sessionLine(shell, 0)).toBe('Idle · pwsh');
    expect(sessionLine(shell, 200)).toBe('Working · pwsh');
  });

  it('gives the reason a session could not start', () => {
    expect(sessionLine({ ...session('x', 'exited'), error: 'Command not found: foo' }, 0)).toBe('Exited · Command not found: foo');
  });
});
