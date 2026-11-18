import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { ConversationItem, CreateSessionRequest, Meta } from '../shared/types.js';
import { hostAllowed, originAllowed, requestAuthorized, safeEqual } from './auth.js';
import { MAX_IMAGE_BYTES, readImage, saveImage } from './backgrounds.js';
import { parseHookBody } from './claude-launch.js';
import type { ClosedStore } from './closed.js';
import { findConversation } from './conversations.js';
import { reopenEntry } from './restore.js';
import { FolderError, listFolders } from './folders.js';
import { assertConfigWritable, ConfigInvalidError, loadConfig, normalizeProfiles, saveConfig } from './config.js';
import { listConversations } from './conversations.js';
import { ScheduleError, type ScheduleStore } from './schedules.js';
import type { SessionManager } from './session-manager.js';
import type { StoryInput, StoryStore } from './stories.js';
import { parseStatusPayload, type UsageStore } from './usage.js';

export interface HttpDeps {
  manager: SessionManager;
  stories: StoryStore;
  usage: UsageStore;
  closed: ClosedStore;
  schedules?: ScheduleStore;
  /** Opens the editor on a session's folder; returns why not, or null when it was started. */
  openEditor?: (session: { command: string; args: string[]; cwd: string }) => string | null;
  /** A hosted Claude session reported a status line: its main screen is up. */
  onClaudeStatus?: (sessionId: string) => void;
  /** A hosted Claude session took a prompt. */
  onPromptSubmitted?: (sessionId: string) => void;
  port: number;
  token: string;
  hookToken: string;
  webDir: string;
  /** Identifies this server instance to the shellyard command. */
  startedAt: number;
  onShutdown: () => void;
}

const MAX_BODY_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const base: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers };
  if (body === undefined) {
    res.writeHead(status, base).end();
    return;
  }
  if (typeof body === 'string') {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...base }).end(body);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...base }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** Reads a body as bytes, for uploads. */
function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) {
      req.resume();
      reject(new HttpError(413, 'File too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) {
        failed = true;
        reject(new HttpError(413, 'File too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolveBody(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const v = await readJson(req);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'Body must be a JSON object');
  return v as Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'Bad session id');
  }
}

function toCreateRequest(b: Record<string, unknown>): CreateSessionRequest {
  const req: CreateSessionRequest = {};
  if (str(b.profileId)) req.profileId = str(b.profileId);
  if (b.kind === 'claude' || b.kind === 'shell') req.kind = b.kind;
  if (str(b.command) !== undefined) req.command = str(b.command);
  if (Array.isArray(b.args)) req.args = b.args.filter((a): a is string => typeof a === 'string');
  else if (b.args !== undefined) req.args = [];
  if (str(b.name) !== undefined) req.name = str(b.name);
  if (str(b.cwd) !== undefined) req.cwd = str(b.cwd);
  if (str(b.color) !== undefined) req.color = str(b.color);
  if (b.model === null || typeof b.model === 'string') req.model = b.model;
  if (b.storyId === null || typeof b.storyId === 'string') req.storyId = b.storyId;
  if (typeof b.resume === 'string') req.resume = b.resume;
  // Present at all (null included) means the request decides; the manager validates it.
  if ('background' in b) req.background = (b.background ?? null) as CreateSessionRequest['background'];
  if ('font' in b) req.font = (b.font ?? null) as CreateSessionRequest['font'];
  return req;
}

function toStoryInput(b: Record<string, unknown>): StoryInput {
  return { name: str(b.name), ticket: str(b.ticket), cwd: str(b.cwd), color: str(b.color) };
}

function serveStatic(webDir: string, pathname: string, res: ServerResponse, port: number): void {
  const root = resolve(webDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    send(res, 400, { error: 'Bad path' });
    return;
  }
  if (decoded.includes('\0')) {
    send(res, 400, { error: 'Bad path' });
    return;
  }
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  let file = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  // Whatever the path decodes to, it must stay inside the web folder.
  const inside = file === root || file.startsWith(root + sep);
  if (!inside || !isFile(file)) {
    // Unknown page paths get the app (it routes in the browser); missing assets are a 404.
    if (inside && extname(decoded) !== '') {
      send(res, 404, { error: 'Not found' });
      return;
    }
    file = resolve(root, 'index.html');
    if (!isFile(file)) {
      send(res, 404, { error: 'The web UI is not built' });
      return;
    }
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'private, max-age=3600',
  };
  if (type.startsWith('text/html')) {
    // 'self' does not cover the ws: scheme in every browser, so the WebSocket is named.
    headers['content-security-policy'] =
      // blob: is how the page shows a terminal background it fetched with its token.
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; ` +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  }
  res.writeHead(200, headers);
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { manager } = deps;

  /** Claude Code names the conversation in every report; that is how a restart can resume it. */
  function noteConversation(sessionId: string, body: unknown): void {
    const reported = (body as { session_id?: unknown } | null)?.session_id;
    if (typeof reported === 'string') manager.setConversation(sessionId, reported);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host, deps.port)) {
      send(res, 403, { error: 'Forbidden host' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${deps.port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/health') {
      send(res, 200, { ok: true, app: 'shellyard', startedAt: deps.startedAt });
      return;
    }

    // Hook events come from Claude Code processes, which hold only the hook token.
    const hookMatch = /^\/api\/hooks\/([^/]+)$/.exec(path);
    if (hookMatch) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const given = req.headers['x-shellyard-hook-token'];
      if (typeof given !== 'string' || !safeEqual(given, deps.hookToken)) throw new HttpError(403, 'Forbidden');
      const raw = await readJson(req);
      const parsed = parseHookBody(raw);
      if (!parsed) throw new HttpError(400, 'Unknown hook event');
      const hookedId = decodeId(hookMatch[1]!);
      if (!manager.hook(hookedId, parsed.name, parsed.idleReminder)) throw new HttpError(404, 'No such live session');
      noteConversation(hookedId, raw);
      if (parsed.name === 'UserPromptSubmit') deps.onPromptSubmitted?.(hookedId);
      send(res, 204);
      return;
    }

    // Status reports come from the status-line command of hosted Claude sessions, which,
    // like the hooks, holds only the hook token.
    const statusMatch = /^\/api\/status\/([^/]+)$/.exec(path);
    if (statusMatch) {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const given = req.headers['x-shellyard-hook-token'];
      if (typeof given !== 'string' || !safeEqual(given, deps.hookToken)) throw new HttpError(403, 'Forbidden');
      const rawStatus = await readJson(req);
      const payload = parseStatusPayload(rawStatus);
      if (!payload) throw new HttpError(400, 'Not a status payload');
      const id = decodeId(statusMatch[1]!);
      // An exited session may still deliver its last figures; an unknown one is refused.
      const session = manager.get(id);
      if (!session) throw new HttpError(404, 'No such session');
      const story = session.storyId ? deps.stories.list().find((s) => s.id === session.storyId) : undefined;
      // The conversation is named first, so that what is counted here is set against it:
      // the same spending turns up again in the transcript when the session ends.
      noteConversation(id, rawStatus);
      deps.usage.record(id, payload, {
        storyId: story?.id ?? null,
        storyName: story?.name ?? null,
        resumed: session.resumed,
        conversationId: manager.conversationOf(id),
      });
      deps.usage.learnModelName(payload.modelId, payload.modelName);
      noteConversation(id, rawStatus);
      if (payload.modelName) manager.setModel(id, payload.modelName);
      deps.onClaudeStatus?.(id);
      send(res, 204);
      return;
    }

    // The app's own files hold no secret, so they need no credential. The page receives the
    // token in the fragment of its address, which browsers never send to a server.
    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      serveStatic(deps.webDir, path, res, deps.port);
      return;
    }

    if (!requestAuthorized(req.headers, deps.token)) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }

    // The token header already cannot be set by another site without a preflight we never
    // approve. Refusing a foreign Origin as well costs nothing and guards against mistakes.
    if (method !== 'GET' && req.headers.origin !== undefined && !originAllowed(req.headers.origin, deps.port)) {
      throw new HttpError(403, 'Forbidden origin');
    }

    if (path === '/api/sessions') {
      if (method === 'GET') return send(res, 200, manager.list());
      if (method === 'POST') return send(res, 201, manager.create(toCreateRequest(await readObject(req))));
      throw new HttpError(405, 'Method not allowed');
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/ack|\/editor)?$/.exec(path);
    if (sessionMatch) {
      const id = decodeId(sessionMatch[1]!);
      if (sessionMatch[2] === '/editor') {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const s = manager.get(id);
        if (!s) throw new HttpError(404, 'No such session');
        // The folder is the session's own, never one the request names.
        const problem = deps.openEditor ? deps.openEditor({ command: s.command, args: s.args, cwd: s.cwd }) : 'Opening an editor is not available here.';
        if (problem) throw new HttpError(409, problem);
        return send(res, 204);
      }
      if (sessionMatch[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const s = manager.ack(id);
        if (!s) throw new HttpError(404, 'No such session');
        return send(res, 200, s);
      }
      if (method === 'PATCH') {
        const b = await readObject(req);
        const storyId = b.storyId === null || typeof b.storyId === 'string' ? b.storyId : undefined;
        const background = 'background' in b ? ((b.background ?? null) as CreateSessionRequest['background']) : undefined;
        const font = 'font' in b ? ((b.font ?? null) as CreateSessionRequest['font']) : undefined;
        const s = manager.update(id, { name: str(b.name), color: str(b.color), storyId, background, font });
        if (!s) throw new HttpError(404, 'No such session');
        return send(res, 200, s);
      }
      if (method === 'DELETE') {
        if (!manager.remove(id)) throw new HttpError(404, 'No such session');
        deps.usage.forgetSession(id);
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/stories') {
      if (method === 'GET') return send(res, 200, deps.stories.list());
      if (method === 'POST') {
        const input = toStoryInput(await readObject(req));
        if (!input.name || !input.name.trim()) throw new HttpError(400, 'A story needs a name.');
        return send(res, 201, deps.stories.create(input));
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const storyMatch = /^\/api\/stories\/([^/]+)$/.exec(path);
    if (storyMatch) {
      const id = decodeId(storyMatch[1]!);
      if (method === 'PATCH') {
        const story = deps.stories.update(id, toStoryInput(await readObject(req)));
        if (!story) throw new HttpError(404, 'No such story');
        return send(res, 200, story);
      }
      if (method === 'DELETE') {
        if (!deps.stories.remove(id)) throw new HttpError(404, 'No such story');
        // Its sessions are not stopped: they simply no longer belong to a story.
        manager.clearStory(id);
        deps.schedules?.clearStory(id);
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/backgrounds') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const name = saveImage(await readBytes(req, MAX_IMAGE_BYTES));
      if (!name) throw new HttpError(400, 'Not an image ShellYard can use. Use a PNG, JPEG, WebP or GIF file.');
      return send(res, 201, { image: name });
    }

    const imageMatch = /^\/api\/backgrounds\/([^/]+)$/.exec(path);
    if (imageMatch) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const image = readImage(decodeId(imageMatch[1]!));
      if (!image) throw new HttpError(404, 'No such image');
      res.writeHead(200, { 'content-type': image.type, 'content-length': String(image.bytes.length), 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' });
      res.end(image.bytes);
      return;
    }

    if (deps.schedules && (path === '/api/schedules' || path.startsWith('/api/schedules/'))) {
      const schedules = deps.schedules;
      // What a schedule refuses is the client's to correct: it is answered with the reason.
      const checked = <T>(fn: () => T): T => {
        try {
          return fn();
        } catch (e) {
          if (e instanceof ScheduleError) throw new HttpError(400, e.message);
          throw e;
        }
      };
      if (path === '/api/schedules') {
        if (method === 'GET') return send(res, 200, schedules.list());
        if (method === 'POST') {
          const body = await readObject(req);
          return send(res, 201, checked(() => schedules.create(body)));
        }
        throw new HttpError(405, 'Method not allowed');
      }
      const scheduleMatch = /^\/api\/schedules\/([^/]+)(\/run)?$/.exec(path);
      if (!scheduleMatch) throw new HttpError(404, 'Not found');
      const id = decodeId(scheduleMatch[1]!);
      if (scheduleMatch[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        const run = schedules.runNow(id);
        if (!run) throw new HttpError(404, 'No such schedule');
        return send(res, 200, run);
      }
      if (method === 'PATCH') {
        const body = await readObject(req);
        const schedule = checked(() => schedules.update(id, body));
        if (!schedule) throw new HttpError(404, 'No such schedule');
        return send(res, 200, schedule);
      }
      if (method === 'DELETE') {
        if (!schedules.remove(id)) throw new HttpError(404, 'No such schedule');
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (path === '/api/closed') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, deps.closed.list());
    }

    const closedMatch = /^\/api\/closed\/([^/]+)(\/reopen)?$/.exec(path);
    if (closedMatch) {
      const id = decodeId(closedMatch[1]!);
      if (closedMatch[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
        // An empty body reopens it where it was; a body may name another area, or none.
        const body = Number(req.headers['content-length'] ?? 0) > 0 ? await readObject(req) : {};
        const entry = deps.closed.take(id);
        if (!entry) throw new HttpError(404, 'No such closed session');
        const storyId = body.storyId === null || typeof body.storyId === 'string' ? body.storyId : entry.storyId;
        const session = reopenEntry(manager, { ...entry, storyId }, findConversation);
        if (session.error) {
          // Not reopened after all: it stays in the list, and no failed session is left behind.
          manager.remove(session.id);
          deps.closed.putBack(entry);
          throw new HttpError(409, session.error);
        }
        // The ended session it came from may still be listed; it has been replaced.
        if (manager.get(entry.sessionId)?.status === 'exited') manager.remove(entry.sessionId);
        return send(res, 201, session);
      }
      if (method !== 'DELETE') throw new HttpError(405, 'Method not allowed');
      if (!deps.closed.remove(id)) throw new HttpError(404, 'No such closed session');
      return send(res, 204);
    }

    if (path === '/api/conversations') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const open = manager.openConversations();
      const items: ConversationItem[] = listConversations().map((c) => ({ ...c, openIn: open.get(c.id) ?? null }));
      return send(res, 200, items);
    }

    if (path === '/api/folders') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      try {
        return send(res, 200, listFolders(url.searchParams.get('path') ?? undefined));
      } catch (e) {
        if (e instanceof FolderError) throw new HttpError(400, e.message);
        throw e;
      }
    }

    if (path === '/api/usage') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, deps.usage.summary());
    }

    if (path === '/api/meta') {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const { config } = loadConfig();
      const meta: Meta = { profiles: manager.profiles(), models: config.models, saved: config.profiles.map((p) => p.id) };
      return send(res, 200, meta);
    }

    if (path === '/api/profiles') {
      if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req);
      if (!Array.isArray(body)) throw new HttpError(400, 'Body must be a list of profiles');
      assertConfigWritable();
      const { config } = loadConfig();
      config.profiles = normalizeProfiles(body);
      saveConfig(config);
      return send(res, 200, config.profiles);
    }

    if (path === '/api/shutdown') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      send(res, 204);
      deps.onShutdown();
      return;
    }

    throw new HttpError(404, 'Not found');
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof ConfigInvalidError) send(res, 409, { error: e.message });
      else if (e instanceof HttpError) send(res, e.status, { error: e.message }, e.status === 413 ? { connection: 'close' } : {});
      else send(res, 500, { error: 'Internal error' });
    });
  };
}
