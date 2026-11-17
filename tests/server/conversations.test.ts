import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findConversation, listConversations } from '../../src/server/conversations.js';
import { useTempHome } from '../helpers.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

describe('saved Claude Code conversations', () => {
  const home = useTempHome();
  let projects = '';

  /** Writes a transcript the way Claude Code does: one JSON object per line. */
  function transcript(project: string, id: string, lines: unknown[], minutesAgo = 0): string {
    const dir = join(projects, project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    const when = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(file, when, when);
    return file;
  }
  const user = (text: unknown, cwd = 'C:\\work\\app'): unknown => ({ type: 'user', message: { role: 'user', content: text }, cwd, sessionId: 'x' });
  const title = (t: string): unknown => ({ type: 'ai-title', aiTitle: t });

  beforeEach(() => {
    projects = join(home.dir(), 'projects');
    mkdirSync(projects);
  });

  it('lists conversations newest first, with folder, title and time', () => {
    transcript('proj-a', ID_A, [{ type: 'mode' }, user('Fix the export bug'), title('Export bug fix')], 30);
    transcript('proj-b', ID_B, [user('Add a test', '/home/me/lib'), title('Test for parser')], 5);
    const list = listConversations({ dir: projects });
    expect(list.map((c) => [c.id, c.title, c.cwd])).toEqual([
      [ID_B, 'Test for parser', '/home/me/lib'],
      [ID_A, 'Export bug fix', 'C:\\work\\app'],
    ]);
    expect(list[0]!.updatedAt).toBeGreaterThan(list[1]!.updatedAt);
  });

  it('falls back to the first thing the user wrote when there is no title yet', () => {
    transcript('p', ID_A, [user('Refactor the payroll module so that it no longer depends on the legacy calendar and reads much better')]);
    const [c] = listConversations({ dir: projects });
    expect(c!.title.startsWith('Refactor the payroll module')).toBe(true);
    expect(c!.title.length).toBeLessThanOrEqual(80);
  });

  it('reads a prompt given as a list of parts, and uses the latest title', () => {
    transcript('p', ID_A, [user([{ type: 'image' }, { type: 'text', text: 'What is in this picture?' }]), title('First title'), title('Better title')]);
    expect(listConversations({ dir: projects })[0]!.title).toBe('Better title');
    transcript('p', ID_B, [user([{ type: 'text', text: 'Parts only' }])]);
    expect(listConversations({ dir: projects }).find((c) => c.id === ID_B)!.title).toBe('Parts only');
  });

  it('decodes escaped characters in a title', () => {
    transcript('p', ID_A, [user('x'), title('Fix "quotes" \\ and — dashes')]);
    expect(listConversations({ dir: projects })[0]!.title).toBe('Fix "quotes" \\ and — dashes');
  });

  it('leaves out sessions in which nothing was asked, since there is nothing to resume', () => {
    transcript('p', ID_A, [{ type: 'mode' }, { type: 'attachment', cwd: 'C:\\x' }]);
    expect(listConversations({ dir: projects })).toEqual([]);
  });

  it('ignores files that are not conversations, sub-folders, and lines it cannot read', () => {
    transcript('p', ID_A, ['{ broken json', user('Still readable'), '']);
    transcript('p', 'notes', [user('not a uuid name')]);
    mkdirSync(join(projects, 'p', ID_B));
    writeFileSync(join(projects, 'p', 'readme.txt'), 'hello');
    writeFileSync(join(projects, 'stray.jsonl'), '{}');
    expect(listConversations({ dir: projects }).map((c) => c.id)).toEqual([ID_A]);
  });

  it('finds the title and the folder in a very large transcript without reading all of it', () => {
    const filler = { type: 'api-request-blob', blob: 'x'.repeat(200_000) };
    transcript('p', ID_A, [user('Big one', 'C:\\big'), ...Array.from({ length: 30 }, () => filler), title('Title near the end'), filler]);
    const started = Date.now();
    const [c] = listConversations({ dir: projects });
    expect(c).toMatchObject({ title: 'Title near the end', cwd: 'C:\\big' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('returns at most the number asked for', () => {
    transcript('p', ID_A, [user('a')], 3);
    transcript('p', ID_B, [user('b')], 2);
    transcript('p', ID_C, [user('c')], 1);
    expect(listConversations({ dir: projects, limit: 2 }).map((c) => c.id)).toEqual([ID_C, ID_B]);
  });

  it('is empty when Claude Code has never run here', () => {
    expect(listConversations({ dir: join(home.dir(), 'no-such-folder') })).toEqual([]);
  });

  describe('findConversation', () => {
    it('finds one by id in any project', () => {
      transcript('proj-a', ID_A, [user('a')]);
      transcript('proj-b', ID_B, [user('b', '/srv/b'), title('B')]);
      expect(findConversation(ID_B, projects)).toMatchObject({ id: ID_B, cwd: '/srv/b', title: 'B' });
    });
    it('returns null for an unknown id, and for anything that is not an id', () => {
      transcript('p', ID_A, [user('a')]);
      expect(findConversation(ID_C, projects)).toBeNull();
      expect(findConversation('../../etc/passwd', projects)).toBeNull();
      expect(findConversation('', projects)).toBeNull();
    });
    it('returns null for a session in which nothing was asked', () => {
      transcript('p', ID_A, [{ type: 'mode' }]);
      expect(findConversation(ID_A, projects)).toBeNull();
    });
  });
});
