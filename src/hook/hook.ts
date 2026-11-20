// Run by Claude Code for every hook event of a session started by ShellYard. It forwards the
// event to the local ShellYard server. It must never disturb the Claude session: exit code 0
// whatever happens, and a short timeout. It prints nothing, with one exception: when the server
// answers a permission request with an area rule's "allow", that decision is printed for
// Claude Code. Anything else (no answer, an error, a reply of another shape) prints nothing,
// and Claude Code asks the user as it always does.

async function readStdin(): Promise<string> {
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

function eventOf(body: string): unknown {
  try {
    return (JSON.parse(body) as { hook_event_name?: unknown } | null)?.hook_event_name;
  } catch {
    return undefined;
  }
}

/** The decision to print: only an "allow" for a permission request, in the shape Claude Code reads. */
function decisionToPrint(event: unknown, status: number, text: string): string | null {
  if (event !== 'PermissionRequest' || status !== 200) return null;
  try {
    const out = JSON.parse(text) as { hookSpecificOutput?: { hookEventName?: unknown; decision?: { behavior?: unknown } } } | null;
    const h = out?.hookSpecificOutput;
    if (h?.hookEventName !== 'PermissionRequest' || h.decision?.behavior !== 'allow') return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const port = process.env.SHELLYARD_PORT;
  const sessionId = process.env.SHELLYARD_SESSION_ID;
  const token = process.env.SHELLYARD_HOOK_TOKEN;
  if (!port || !sessionId || !token) return;
  const body = await readStdin();
  const res = await fetch(`http://127.0.0.1:${port}/api/hooks/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shellyard-hook-token': token },
    body,
    signal: AbortSignal.timeout(2000),
  });
  const decision = decisionToPrint(eventOf(body), res.status, res.status === 200 ? await res.text() : '');
  // Written out before the process exits: on a pipe, a write can still be on its way.
  if (decision) await new Promise<void>((done) => process.stdout.write(decision, () => done()));
}

main()
  .catch(() => {
    // A stopped server or a slow one is not the Claude session's problem.
  })
  .finally(() => process.exit(0));
