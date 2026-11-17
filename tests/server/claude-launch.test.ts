import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupClaudeLaunch, parseHookBody, prepareClaudeLaunch, withoutClaudeSessionMarkers } from '../../src/server/claude-launch.js';
import { useTempHome } from '../helpers.js';

const base = { sessionId: 'sess-1', port: 7717, hookToken: 'hook-token', hookScriptPath: 'C:\\pkg\\dist\\hook\\hook.js', statusScriptPath: 'C:\\pkg\\dist\\hook\\statusline.js', extraArgs: [] };

describe('prepareClaudeLaunch', () => {
  const home = useTempHome();

  it('omits --model when no model is chosen', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    expect(out.args).toEqual(['--settings', out.settingsPath, '--session-id', 'sess-1']);
  });

  it('passes the chosen model after the session id, then any extra arguments', () => {
    const out = prepareClaudeLaunch({ ...base, model: 'opus', extraArgs: ['--verbose'] });
    expect(out.args).toEqual(['--settings', out.settingsPath, '--session-id', 'sess-1', '--model', 'opus', '--verbose']);
  });

  it('registers a status line that reports usage to TTC', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    const settings = JSON.parse(readFileSync(out.settingsPath, 'utf8'));
    expect(settings.statusLine).toEqual({ type: 'command', command: `"${process.execPath}" "C:\\pkg\\dist\\hook\\statusline.js"` });
  });

  it('writes a settings file holding only the five hooks and the status line', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    expect(out.settingsPath).toBe(join(home.dir(), 'run', 'sess-1.settings.json'));
    const settings = JSON.parse(readFileSync(out.settingsPath, 'utf8'));
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'statusLine']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
    for (const entries of Object.values<any>(settings.hooks)) {
      expect(entries).toEqual([{ hooks: [{ type: 'command', command: `"${process.execPath}" "C:\\pkg\\dist\\hook\\hook.js"` }] }]);
    }
  });

  it('hands the session its identity through the environment', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    expect(out.env).toEqual({ TTC_SESSION_ID: 'sess-1', TTC_PORT: '7717', TTC_HOOK_TOKEN: 'hook-token' });
  });

  it('cleans up, and is silent when there is nothing to clean', () => {
    const out = prepareClaudeLaunch({ ...base, model: null });
    cleanupClaudeLaunch('sess-1');
    expect(existsSync(out.settingsPath)).toBe(false);
    expect(() => cleanupClaudeLaunch('sess-1')).not.toThrow();
    expect(() => cleanupClaudeLaunch('never-existed')).not.toThrow();
  });
});

describe('withoutClaudeSessionMarkers', () => {
  it('drops the variables that mark a nested Claude Code session and keeps the rest', () => {
    const out = withoutClaudeSessionMarkers({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_PID: '42',
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'keep-me',
      CLAUDE_CONFIG_DIR: '/custom',
      CLAUDE_CODE_USE_BEDROCK: '1',
      UNSET: undefined,
    });
    expect(out).toEqual({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'keep-me',
      CLAUDE_CONFIG_DIR: '/custom',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
  });
});

describe('parseHookBody', () => {
  it('reads the event name', () => {
    expect(parseHookBody({ hook_event_name: 'Stop' })).toEqual({ name: 'Stop', idleReminder: false });
    expect(parseHookBody({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual({ name: 'PreToolUse', idleReminder: false });
  });

  it('rejects unknown events and non-objects', () => {
    expect(parseHookBody({ hook_event_name: 'Nope' })).toBeNull();
    expect(parseHookBody('x')).toBeNull();
    expect(parseHookBody(null)).toBeNull();
    expect(parseHookBody([])).toBeNull();
    expect(parseHookBody({})).toBeNull();
  });

  it('treats a permission notification as a real request', () => {
    expect(parseHookBody({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
      .toEqual({ name: 'Notification', idleReminder: false });
  });

  it('recognises the idle reminder by its type', () => {
    expect(parseHookBody({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }))
      .toEqual({ name: 'Notification', idleReminder: true });
  });

  it('recognises the idle reminder by its message when the type is missing', () => {
    expect(parseHookBody({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }))
      .toEqual({ name: 'Notification', idleReminder: true });
  });

  it('treats a notification it cannot classify as a real request', () => {
    expect(parseHookBody({ hook_event_name: 'Notification' })).toEqual({ name: 'Notification', idleReminder: false });
    expect(parseHookBody({ hook_event_name: 'Notification', notification_type: 'something_new' }))
      .toEqual({ name: 'Notification', idleReminder: false });
  });
});
