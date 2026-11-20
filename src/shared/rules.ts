// Area rules: Bash commands that the sessions of an area may run without asking. Shared by the
// server, which decides, and the page, which shows what a rule would cover.
//
// A rule is a command, word by word, optionally ending in "*" for "any further arguments".
// Only plain commands are ever covered: anything that chains, pipes, redirects, substitutes or
// spans lines (;  &  |  >  <  $  `  (  )  {  }  line breaks) always asks, even inside quotes,
// because telling quoted text from shell syntax reliably is exactly what a rule must not get
// wrong. A command led by a variable assignment (PATH=… cmd) always asks too.

/** Characters that never appear in a command a rule may cover; tab is the one control character allowed. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[;&|<>$`(){}\x00-\x08\x0a-\x1f\x7f]/;
const MAX_PATTERN = 300;

/**
 * The words of a command, quoted parts kept whole and as written, or null when the command is
 * not one a rule may ever cover.
 */
export function commandTokens(command: string): string[] | null {
  if (UNSAFE.test(command)) return null;
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (quote) return null;
  if (current) tokens.push(current);
  const first = tokens[0];
  if (!first || first.includes('=') || first.startsWith('-')) return null;
  return tokens;
}

interface Pattern {
  words: string[];
  /** Ends in "*": any further arguments. */
  open: boolean;
}

function parsePattern(pattern: string): Pattern | string {
  if (pattern.length > MAX_PATTERN) return `A rule is at most ${MAX_PATTERN} characters long.`;
  const trimmed = pattern.trim();
  const open = trimmed === '*' || /\s\*$/.test(trimmed);
  const body = open ? trimmed.slice(0, -1) : trimmed;
  if (!body.trim()) return 'Write the command a rule allows, such as "dotnet test *".';
  const words = commandTokens(body);
  if (!words) return 'A rule covers plain commands only: nothing that chains, pipes, redirects or substitutes (; & | > < $ ` and brackets), and no VAR=value in front.';
  if (words.includes('*')) return 'Only the last word of a rule can be *.';
  return { words, open };
}

/** Why a pattern cannot be a rule, or null when it can. */
export function patternError(pattern: string): string | null {
  const p = parsePattern(pattern);
  return typeof p === 'string' ? p : null;
}

/** The pattern as stored and shown: single spaces, "*" last if open. */
export function normalizePattern(pattern: string): string | null {
  const p = parsePattern(pattern);
  if (typeof p === 'string') return null;
  return [...p.words, ...(p.open ? ['*'] : [])].join(' ');
}

/** Whether a rule allows a command. A command that is not safe is never allowed. */
export function ruleMatches(pattern: string, command: string): boolean {
  const p = parsePattern(pattern);
  const words = commandTokens(command);
  if (typeof p === 'string' || !words) return false;
  if (p.open ? words.length < p.words.length : words.length !== p.words.length) return false;
  return p.words.every((w, i) => words[i] === w);
}

/** A word that reads as a subcommand (test, push, run), not an option, a path or a value. */
const SUBCOMMAND = /^[A-Za-z][\w-]*$/;

/**
 * The rule "Always in this area" makes from a command: the program and its subcommand with any
 * arguments ("dotnet test *"); the whole command when it is that short, or when its second word
 * is an option or a path, so that "rm -rf build" never becomes "rm -rf *". Null when the
 * command can never be a rule.
 */
export function suggestPattern(command: string): string | null {
  const words = commandTokens(command);
  if (!words) return null;
  if (words.length > 2 && SUBCOMMAND.test(words[1]!)) return `${words[0]} ${words[1]} *`;
  return words.join(' ');
}
