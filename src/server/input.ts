// What reaches a session as "input" is not always the user typing. A terminal also answers
// questions the program asks it (where is the cursor, what colours do you have) and reports
// focus changes and mouse movement, all through the same channel. Those must reach the
// program, but they say nothing about whether the user has responded to it.

const REPORTS = [
  /^\x1b\[[IO]/, // focus in / out
  /^\x1b\[\d+;\d+R/, // cursor position report
  /^\x1b\[[?>=][\d;]*c/, // device attributes
  /^\x1b\[\d*n/, // device status
  /^\x1b\[\??[\d;]*\$y/, // mode report
  /^\x1b\[<\d+;\d+;\d+[Mm]/, // mouse report (SGR)
  /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/, // OSC answer, e.g. colours
  /^\x1bP[^\x1b]*\x1b\\/, // DCS answer
];

/** True when the data consists only of replies a terminal emits by itself. */
export function isTerminalReport(data: string): boolean {
  if (data === '') return false;
  let rest = data;
  while (rest !== '') {
    let matched = false;
    for (const re of REPORTS) {
      const m = re.exec(rest);
      if (m) {
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}
