import { describe, expect, it } from 'vitest';
import { fillTemplate, newRecipe, normalizeTicket, planTicket, recipeError, type Recipe } from '../../src/shared/recipes.js';

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  ...newRecipe('C:\\repos\\hcm'),
  id: 'r1',
  name: 'Bug fix',
  sessions: [
    { profileId: 'builtin-claude', model: 'claude-opus-5-5', prompt: 'Read the ticket {ticket}, propose a plan, wait for my OK.' },
    { profileId: 'builtin-pwsh', model: null, prompt: '' },
  ],
  ...over,
});

describe('normalizeTicket', () => {
  it('takes a ticket code in any case, trimmed', () => {
    expect(normalizeTicket(' hcm-7912 ')).toBe('HCM-7912');
    expect(normalizeTicket('ABC2-1')).toBe('ABC2-1');
  });

  it('refuses anything that is not KEY-number', () => {
    for (const t of ['', '7912', 'HCM7912', 'HCM-', '-12', 'HCM-12a', 'HCM-12 x', '../HCM-1', 'HCM-1;rm']) expect(normalizeTicket(t), t).toBeNull();
  });
});

describe('fillTemplate', () => {
  it('puts in the ticket, the ticket in lower case and the repository', () => {
    expect(fillTemplate('feat/{ticket-lower}', 'HCM-7912', '/r/hcm')).toBe('feat/hcm-7912');
    expect(fillTemplate('{repo}-{ticket-lower}', 'HCM-7912', '/r/hcm')).toBe('/r/hcm-hcm-7912');
    expect(fillTemplate('Read {ticket} and {ticket}', 'HCM-1', '/r')).toBe('Read HCM-1 and HCM-1');
  });
});

describe('newRecipe', () => {
  it('starts with a feature branch from main, in a folder next to the repository', () => {
    expect(newRecipe('/r/hcm')).toMatchObject({ repo: '/r/hcm', base: 'main', branch: 'feat/{ticket-lower}', folder: '{repo}-{ticket-lower}', sessions: [] });
  });
});

describe('planTicket', () => {
  it('works out the area, the worktree, the branch and the sessions from a ticket', () => {
    expect(planTicket(recipe(), 'hcm-7912')).toEqual({
      ticket: 'HCM-7912',
      areaName: 'HCM-7912',
      repo: 'C:\\repos\\hcm',
      base: 'main',
      branch: 'feat/hcm-7912',
      worktree: 'C:\\repos\\hcm-hcm-7912',
      sessions: [
        { profileId: 'builtin-claude', model: 'claude-opus-5-5', prompt: 'Read the ticket HCM-7912, propose a plan, wait for my OK.' },
        { profileId: 'builtin-pwsh', model: null, prompt: '' },
      ],
    });
  });

  it('says why a ticket or a recipe gives no plan', () => {
    expect(planTicket(recipe(), 'nope')).toEqual({ error: expect.stringMatching(/ticket code/i) });
    expect(planTicket(recipe({ folder: 'relative/{ticket}' }), 'HCM-1')).toEqual({ error: expect.stringMatching(/absolute/i) });
  });
});

describe('recipeError', () => {
  it('accepts a complete recipe', () => {
    expect(recipeError(recipe())).toBeNull();
  });

  it('wants a name, an absolute repository, a branch and a folder that name the ticket, and sessions', () => {
    expect(recipeError(recipe({ name: ' ' }))).toMatch(/name/i);
    expect(recipeError(recipe({ repo: 'repos/hcm' }))).toMatch(/absolute/i);
    expect(recipeError(recipe({ branch: 'feat/fixed' }))).toMatch(/branch/i);
    expect(recipeError(recipe({ folder: '{repo}-work' }))).toMatch(/folder/i);
    expect(recipeError(recipe({ base: '-x' }))).toMatch(/base/i);
    expect(recipeError(recipe({ sessions: [] }))).toMatch(/session/i);
    expect(recipeError(recipe({ sessions: [{ profileId: '', model: null, prompt: '' }] }))).toMatch(/launcher/i);
  });
});
