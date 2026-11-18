/**
 * Splits a command line typed by the user into the program and its arguments, on spaces.
 * Double quotes keep spaces inside one argument: "C:\Program Files\x.exe" -a stays two parts.
 */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of line.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) parts.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) parts.push(current);
  return parts;
}
