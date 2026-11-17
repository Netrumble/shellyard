import { describe, expect, it } from 'vitest';
import { isTerminalReport } from '../../src/server/input.js';

describe('isTerminalReport', () => {
  it('recognises replies a terminal sends by itself', () => {
    const reports = [
      '\x1b[I', // focus in
      '\x1b[O', // focus out
      '\x1b[12;40R', // cursor position
      '\x1b[?1;2c', // device attributes
      '\x1b[>0;276;0c', // secondary device attributes
      '\x1b[0n', // status ok
      '\x1b[?2026;2$y', // mode report
      '\x1b]11;rgb:0c0c/0d0d/1010\x07', // colour query answer (BEL)
      '\x1b]10;rgb:d7d7/dada/e0e0\x1b\\', // colour query answer (ST)
      '\x1bP1$r0m\x1b\\', // DCS answer
      '\x1b[<35;10;5M', // mouse movement
      '\x1b[<0;10;5m', // mouse release
      '\x1b[I\x1b[12;40R\x1b[?1;2c', // several at once
    ];
    for (const r of reports) expect(isTerminalReport(r), JSON.stringify(r)).toBe(true);
  });

  it('treats anything a person can type as input', () => {
    const typed = [
      'a',
      '1',
      '\r',
      '\x1b', // Esc
      '\x03', // Ctrl+C
      '\x1b[A', // arrow up
      '\x1b[B',
      '\x1b[Z', // shift+tab
      '\x1b[3~', // delete
      '\x1bOP', // F1
      '\x7f', // backspace
      'hello world',
      '\x1b[200~pasted text\x1b[201~', // bracketed paste
      '\x1b[Iy', // a focus report followed by a real key
    ];
    for (const t of typed) expect(isTerminalReport(t), JSON.stringify(t)).toBe(false);
  });

  it('does not call empty data a report', () => {
    expect(isTerminalReport('')).toBe(false);
  });
});
