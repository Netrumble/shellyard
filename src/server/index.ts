import { readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPageHost, newToken } from './auth.js';
import { ActivityMeter } from './activity.js';
import { RuleStore } from './area-rules.js';
import { RecipeStore } from './recipes.js';
import { StatusLog } from './status-log.js';
import { ClosedStore } from './closed.js';
import { clearServerState, dataDir, loadConfig, readServerState, writeServerState } from './config.js';
import { openInEditor } from './editor.js';
import { createRequestHandler } from './http.js';
import { realPtyFactory, type PtyFactory } from './pty-session.js';
import { claudeProjectsDir, findConversation } from './conversations.js';
import { TranscriptScanner } from './transcript-usage.js';
import { PromptDelivery } from './prompt-delivery.js';
import { loadRestorable, restoreSessions, saveRestorable } from './restore.js';
import { launcherFingerprint, ScheduleStore, type LaunchResult } from './schedules.js';
import { SessionManager } from './session-manager.js';
import { SoundStore } from './sounds.js';
import { StoryStore } from './stories.js';
import { UsageStore } from './usage.js';
import type { Schedule } from '../shared/types.js';
import { attachWebSocket } from './ws.js';
import { ChangeTracker, changesOf } from './changes.js';

export const DEFAULT_PORT = 7717;

/** The version of the package this file belongs to (from dist/server or src/server alike). */
export function packageVersion(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}
const HOST = '127.0.0.1';
const PORT_ATTEMPTS = 51;
/** How much transcript is read in one go; small enough not to be felt while typing. */
const SCAN_STEP_BYTES = 4 * 1024 * 1024;
const SCAN_BUSY_MS = 100;
const SCAN_IDLE_MS = 3000;

export interface RunningServer {
  port: number;
  /** The host name the page is served on in this start. */
  pageHost: string;
  token: string;
  address: string;
  stop(): Promise<void>;
  /** Resolves once the server has stopped, however that was triggered. */
  stopped: Promise<void>;
}

export interface StartOptions {
  port?: number;
  ptyFactory?: PtyFactory;
  quiet?: boolean;
  /** Stands in for starting VS Code, in tests. */
  openEditor?: typeof openInEditor;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Binds the server itself to the first free port from `start`. Probing a port and binding
 * it afterwards leaves a gap in which another program can take it, so the real bind is the test.
 */
async function listenOnFirstFree(server: Server, start: number): Promise<number> {
  for (let port = start; port < start + PORT_ATTEMPTS && port <= 65535; port++) {
    try {
      await listen(server, port);
      return port;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
    }
  }
  throw new Error(`No free port between ${start} and ${start + PORT_ATTEMPTS - 1}`);
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const log = (msg: string): void => {
    if (!opts.quiet) console.log(`${new Date().toISOString()} ${msg}`);
  };

  const first = loadConfig({ quarantineCorrupt: true });
  if (first.warning) log(`warning: ${first.warning}`);

  const server = createServer();
  const port = await listenOnFirstFree(server, opts.port ?? DEFAULT_PORT);
  const token = newToken();
  const hookToken = newToken();
  // A new host name for the page at every start: see newPageHost.
  const pageHost = newPageHost();
  const startedAt = Date.now();
  const here = dirname(fileURLToPath(import.meta.url));

  const stories = new StoryStore();
  stories.ensureColors();
  const sounds = new SoundStore(stories);
  const manager = new SessionManager({
    stories: () => stories.list(),
    ptyFactory: opts.ptyFactory ?? realPtyFactory,
    now: Date.now,
    // Read on every use so edits to config.json apply without a restart.
    config: () => loadConfig().config,
    port,
    hookToken,
    hookScriptPath: join(here, '..', 'hook', 'hook.js'),
    statusScriptPath: join(here, '..', 'hook', 'statusline.js'),
  });
  const usage = new UsageStore({ now: Date.now, file: join(dataDir(), 'usage.json') });
  const activity = new ActivityMeter(Date.now);
  manager.onOutput((id, data) => activity.add(id, data.length));
  // Sessions that end or are closed are remembered, to be opened again from their area.
  const closed = new ClosedStore({ file: join(dataDir(), 'closed.json'), now: Date.now });
  const rules = new RuleStore({ file: join(dataDir(), 'rules.json'), now: Date.now });
  const recipes = new RecipeStore({ file: join(dataDir(), 'recipes.json') });
  const flow = new StatusLog({ now: Date.now, file: join(dataDir(), 'flow.json') });
  manager.onChange((sessions) => flow.observe(sessions));
  manager.onClosed((entry, sessionId) => closed.add(entry, sessionId));
  // The uncommitted changes of the worktrees sessions work in, for the badges on the page.
  const changes = new ChangeTracker({ read: (worktree) => changesOf(worktree) });
  const trackWorktrees = (): void =>
    changes.track(
      manager
        .list()
        .filter((s) => s.status !== 'exited' && s.git)
        .map((s) => s.git!.worktree),
    );
  manager.onChange(trackWorktrees);

  // Schedules: at its time, a schedule opens a Claude Code session like any other, and its
  // prompt is typed into the terminal once Claude Code is ready for it.
  const delivery = new PromptDelivery({
    now: Date.now,
    write: (id, data) => manager.input(id, data),
    alive: (id) => {
      const s = manager.get(id);
      return s !== null && s.status !== 'exited';
    },
  });
  const launchSchedule = (schedule: Schedule): LaunchResult => {
    const profile = manager.profiles().find((p) => p.id === schedule.profileId);
    if (!profile) return { error: 'The launcher of this schedule no longer exists.' };
    if (profile.kind !== 'claude') return { error: `The launcher "${profile.name}" does not start Claude Code.` };
    const storyId = schedule.storyId !== null && stories.list().some((s) => s.id === schedule.storyId) ? schedule.storyId : null;
    const session = manager.create({
      profileId: profile.id,
      name: schedule.name,
      storyId,
      ...(schedule.cwd ? { cwd: schedule.cwd } : {}),
      ...(schedule.model ? { model: schedule.model } : {}),
      args: [...profile.args, ...(schedule.permissionMode === 'default' ? [] : ['--permission-mode', schedule.permissionMode])],
    });
    if (session.error) {
      // Nobody is watching: a session that never started is recorded in the run, not left open.
      manager.remove(session.id);
      return { error: session.error };
    }
    delivery.expect(session.id, schedule.prompt, (outcome, detail) => schedules.resolveRun(schedule.id, session.id, outcome, detail));
    log(`schedule "${schedule.name}": started session ${session.id}`);
    return { sessionId: session.id };
  };
  const schedules: ScheduleStore = new ScheduleStore({
    file: join(dataDir(), 'schedules.json'),
    now: Date.now,
    launch: launchSchedule,
    fingerprint: (profileId) => {
      const profile = manager.profiles().find((p) => p.id === profileId);
      return profile ? launcherFingerprint(profile) : null;
    },
    busy: (id) => {
      const s = manager.get(id);
      return s !== null && (s.status === 'working' || (s.status === 'attention' && s.reason === 'blocked'));
    },
  });
  schedules.start();
  // How each run goes: when it waits on the user, when it finishes.
  manager.onChange((sessions) => schedules.observe(sessions));
  const deliveryTicker = setInterval(() => delivery.tick(), 200);
  deliveryTicker.unref?.();

  // Sessions open at the last stop come back; from then on the list is kept current, so that
  // it is right even if the server is killed. An orderly stop must not empty it: stopping
  // ends every process, which is not the user closing their sessions.
  const sessionsFile = join(dataDir(), 'sessions.json');
  if (first.config.restoreSessions) {
    const previous = loadRestorable(sessionsFile);
    if (previous.length > 0) {
      log(`restoring ${previous.length} session(s) from the last run`);
      restoreSessions(manager, previous, findConversation);
    }
  }
  // Costs are read from Claude Code's transcripts, a little at a time so that terminals are
  // never held up: quickly while there is a backlog (the first start reads a month of them),
  // then at an idle pace.
  const scanner = new TranscriptScanner({
    dir: claudeProjectsDir,
    usage,
    now: Date.now,
    storyOf: (conversationId) => {
      const sessionId = manager.openConversations().get(conversationId);
      const storyId = sessionId ? manager.get(sessionId)?.storyId : null;
      const story = storyId ? stories.list().find((s) => s.id === storyId) : undefined;
      return { storyId: story?.id ?? null, storyName: story?.name ?? null };
    },
  });
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanning = true;
  const scanLoop = async (): Promise<void> => {
    if (!scanning) return;
    let more = false;
    try {
      more = await scanner.tick(SCAN_STEP_BYTES);
    } catch (e) {
      log(`usage: could not read transcripts: ${(e as Error).message}`);
    }
    if (!scanning) return;
    scanTimer = setTimeout(() => void scanLoop(), more ? SCAN_BUSY_MS : SCAN_IDLE_MS);
    scanTimer.unref?.();
  };
  scanTimer = setTimeout(() => void scanLoop(), 300);
  scanTimer.unref?.();

  let saving = true;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveNow = (): void => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (saving) saveRestorable(sessionsFile, manager.restorable());
  };
  manager.onChange(() => {
    if (!saving || saveTimer) return;
    saveTimer = setTimeout(saveNow, 200);
    saveTimer.unref?.();
  });
  saveNow();

  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((r) => (resolveStopped = r));
  let stopping: Promise<void> | null = null;

  const ws = attachWebSocket(server, { manager, stories, rules, closed, schedules, usage, activity, changes, port, pageHost, token });
  const ticker = setInterval(() => {
    manager.tick();
    schedules.tick();
  }, 1000);
  // A branch switched or a commit made inside a terminal shows up without a git process.
  const headTicker = setInterval(() => manager.refreshHeads(), 10_000);
  // Changes made outside Claude's tools (an editor, a shell) show up within this time.
  const changesTicker = setInterval(() => void changes.refreshAll(), 15_000);
  changesTicker.unref?.();
  // The day totals of the flow are written now and then, and on stopping.
  const flowTicker = setInterval(() => flow.persist(), 60_000);
  flowTicker.unref?.();

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(ticker);
      clearInterval(headTicker);
      clearInterval(changesTicker);
      changes.stop();
      clearInterval(flowTicker);
      clearInterval(deliveryTicker);
      scanning = false;
      clearTimeout(scanTimer);
      saveNow();
      saving = false;
      manager.shutdown();
      schedules.flush();
      usage.flush();
      flow.observe([]);
      flow.persist();
      ws.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      // Another server may have taken over the state file since; only remove our own.
      const recorded = readServerState();
      if (recorded && recorded.pid === process.pid && recorded.startedAt === startedAt) clearServerState();
      log('stopped');
      resolveStopped();
    })();
    return stopping;
  };

  server.on(
    'request',
    createRequestHandler({
      manager,
      stories,
      sounds,
      usage,
      closed,
      schedules,
      rules,
      recipes,
      flow,
      // The outcome is visible in the session itself; nothing waits on it here.
      deliverPrompt: (id, prompt) => delivery.expect(id, prompt, () => undefined),
      openEditor: opts.openEditor ?? openInEditor,
      onClaudeStatus: (id) => delivery.ready(id),
      onPromptSubmitted: (id) => delivery.submitted(id),
      // After Claude uses a tool or ends a turn, its worktree is read again.
      onHook: (id, name) => {
        if (name !== 'PostToolUse' && name !== 'Stop') return;
        const worktree = manager.get(id)?.git?.worktree;
        if (worktree) changes.soon(worktree);
      },
      changes,
      port,
      pageHost,
      token,
      hookToken,
      webDir: join(here, '..', 'web'),
      version: packageVersion(),
      // Let the 204 reach the caller before the sockets are torn down.
      onShutdown: () => void setTimeout(() => void stop(), 50),
    }),
  );

  writeServerState({ pid: process.pid, port, pageHost, token, hookToken, startedAt });
  log(`listening on http://${HOST}:${port}, page on http://${pageHost}:${port}`);

  return { port, pageHost, token, address: (server.address() as AddressInfo).address, stop, stopped };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : undefined;
  // One failing session must not take the others down with it.
  process.on('uncaughtException', (e) => console.error(`${new Date().toISOString()} uncaught: ${e.stack ?? e}`));
  process.on('unhandledRejection', (e) => console.error(`${new Date().toISOString()} unhandled: ${String(e)}`));
  startServer({ port: Number.isInteger(port) ? port : undefined })
    .then((running) => {
      const shutdown = (): void => void running.stop();
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      void running.stopped.then(() => process.exit(0));
    })
    .catch((e: unknown) => {
      console.error(`${new Date().toISOString()} failed to start: ${(e as Error).stack ?? e}`);
      process.exit(1);
    });
}
