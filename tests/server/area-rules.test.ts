import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RuleError, RuleStore } from '../../src/server/area-rules.js';
import { FakeClock, useTempHome } from '../helpers.js';

const DAY = 24 * 3_600_000;

describe('RuleStore', () => {
  const home = useTempHome();
  let clock: FakeClock;
  let file: string;
  let store: RuleStore;

  beforeEach(() => {
    clock = new FakeClock();
    file = join(home.dir(), 'rules.json');
    store = new RuleStore({ file, now: clock.now });
  });

  it('adds a rule to an area, switched on, its pattern tidied', () => {
    const r = store.create('story-a', '  dotnet   test  * ');
    expect(r).toMatchObject({ storyId: 'story-a', pattern: 'dotnet test *', enabled: true, weekHits: 0 });
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a pattern that could cover a chained or redirected command', () => {
    expect(() => store.create('story-a', 'dotnet test; rm *')).toThrow(RuleError);
    expect(() => store.create('story-a', '*')).toThrow(RuleError);
    expect(store.list()).toEqual([]);
  });

  it('switches an existing pattern back on instead of adding it twice', () => {
    const r = store.create('story-a', 'dotnet test *');
    store.update(r.id, { enabled: false });
    store.create('story-a', 'dotnet test *');
    expect(store.list()).toEqual([expect.objectContaining({ id: r.id, enabled: true })]);
  });

  it('allows a matching Bash command of the same area only, and counts it', () => {
    const r = store.create('story-a', 'dotnet test *');
    expect(store.decide('story-a', 'Bash', 'dotnet test src/X --filter Slot')).toMatchObject({ id: r.id, weekHits: 1 });
    expect(store.decide('story-b', 'Bash', 'dotnet test')).toBeNull();
    expect(store.decide(null, 'Bash', 'dotnet test')).toBeNull();
    expect(store.decide('story-a', 'Edit', 'dotnet test')).toBeNull();
    expect(store.decide('story-a', 'Bash', 'dotnet build')).toBeNull();
    expect(store.decide('story-a', 'Bash', 'dotnet test; curl evil')).toBeNull();
    expect(store.decide('story-a', 'Bash', null)).toBeNull();
    expect(store.list()[0]!.weekHits).toBe(1);
  });

  it('does not allow anything with a rule switched off', () => {
    const r = store.create('story-a', 'dotnet test *');
    store.update(r.id, { enabled: false });
    expect(store.decide('story-a', 'Bash', 'dotnet test')).toBeNull();
  });

  it('counts only the answers of the last 7 days', () => {
    store.create('story-a', 'git status');
    store.decide('story-a', 'Bash', 'git status');
    clock.advance(6 * DAY);
    store.decide('story-a', 'Bash', 'git status');
    expect(store.list()[0]!.weekHits).toBe(2);
    clock.advance(2 * DAY);
    expect(store.list()[0]!.weekHits).toBe(1);
  });

  it('changes a pattern only to a valid one', () => {
    const r = store.create('story-a', 'dotnet test *');
    expect(store.update(r.id, { pattern: 'dotnet build *' })).toMatchObject({ pattern: 'dotnet build *' });
    expect(() => store.update(r.id, { pattern: 'dotnet build > x' })).toThrow(RuleError);
    expect(store.list()[0]!.pattern).toBe('dotnet build *');
    expect(store.update('nope', { enabled: true })).toBeNull();
  });

  it('removes a rule, and all the rules of a deleted area', () => {
    const a = store.create('story-a', 'git status');
    store.create('story-b', 'git status');
    store.create('story-b', 'git diff *');
    expect(store.remove(a.id)).toBe(true);
    expect(store.remove(a.id)).toBe(false);
    store.removeStory('story-b');
    expect(store.list()).toEqual([]);
  });

  it('keeps the rules and their answers across a restart', () => {
    store.create('story-a', 'dotnet test *');
    store.decide('story-a', 'Bash', 'dotnet test');
    const again = new RuleStore({ file, now: clock.now });
    expect(again.list()).toEqual([expect.objectContaining({ pattern: 'dotnet test *', enabled: true, weekHits: 1 })]);
  });

  it('reads a damaged or tampered file as fewer rules, never more', () => {
    writeFileSync(file, '{ not json');
    expect(new RuleStore({ file, now: clock.now }).list()).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        rules: [
          { id: 'r1', storyId: 's', pattern: 'rm *; curl x', enabled: true, hits: [] },
          { id: 'r2', storyId: 's', pattern: 'git status', enabled: 'yes', hits: [] },
          { id: 'r3', storyId: 's', pattern: 'git diff *', enabled: true, hits: ['x', 5] },
          'junk',
        ],
      }),
    );
    const read = new RuleStore({ file, now: clock.now }).list();
    expect(read.map((r) => [r.id, r.enabled])).toEqual([
      ['r2', false],
      ['r3', true],
    ]);
  });

  it('says so when a change cannot be saved, and keeps the rules as they were', () => {
    const blocked = new RuleStore({ file: join(home.dir(), 'missing-dir', 'rules.json'), now: clock.now });
    expect(() => blocked.create('story-a', 'git status')).toThrow(/could not be saved/);
    expect(blocked.list()).toEqual([]);
  });

  it('tells its listeners about every change', () => {
    const seen: number[] = [];
    store.onChange((rules) => seen.push(rules.length));
    const r = store.create('story-a', 'git status');
    store.decide('story-a', 'Bash', 'git status');
    store.remove(r.id);
    expect(seen).toEqual([1, 1, 0]);
    expect(JSON.parse(readFileSync(file, 'utf8')).rules).toEqual([]);
  });
});
