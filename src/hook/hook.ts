// Run by Claude Code for every hook event of a session started by ShellYard. It forwards the
// event to the local ShellYard server. It must never disturb the Claude session: no output,
// exit code 0 whatever happens, and a short timeout.

async function readStdin(): Promise<string> {
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

async function main(): Promise<void> {
  const port = process.env.SHELLYARD_PORT;
  const sessionId = process.env.SHELLYARD_SESSION_ID;
  const token = process.env.SHELLYARD_HOOK_TOKEN;
  if (!port || !sessionId || !token) return;
  const body = await readStdin();
  await fetch(`http://127.0.0.1:${port}/api/hooks/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shellyard-hook-token': token },
    body,
    signal: AbortSignal.timeout(2000),
  });
}

main()
  .catch(() => {
    // A stopped server or a slow one is not the Claude session's problem.
  })
  .finally(() => process.exit(0));
