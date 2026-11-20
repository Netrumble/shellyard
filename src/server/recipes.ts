import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cleanRepo, recipeError, type Recipe, type RecipeSession } from '../shared/recipes.js';

// The recipes of "Start from ticket", in recipes.json. A file that cannot be read gives none.

const FILE_VERSION = 1;
const MAX_PROMPT = 20_000;

export class RecipeError extends Error {}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function toSession(v: unknown): RecipeSession | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const profileId = str(o.profileId);
  if (!profileId) return null;
  const prompt = typeof o.prompt === 'string' ? o.prompt.slice(0, MAX_PROMPT) : '';
  return { profileId, model: str(o.model) || null, prompt };
}

/** A recipe from what was sent or read, its fields tidied; validity is checked separately. */
export function toRecipeFields(v: unknown): Omit<Recipe, 'id'> {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return {
    name: str(o.name),
    repo: cleanRepo(str(o.repo)),
    base: str(o.base),
    branch: str(o.branch),
    folder: str(o.folder),
    sessions: Array.isArray(o.sessions) ? o.sessions.map(toSession).filter((s): s is RecipeSession => s !== null).slice(0, 10) : [],
  };
}

export class RecipeStore {
  private recipes: Recipe[];

  constructor(private readonly deps: { file: string }) {
    this.recipes = this.load();
  }

  private load(): Recipe[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.deps.file, 'utf8'));
      const list = (raw as { recipes?: unknown } | null)?.recipes;
      if (!Array.isArray(list)) return [];
      const out: Recipe[] = [];
      for (const item of list) {
        const id = str((item as { id?: unknown } | null)?.id);
        const fields = toRecipeFields(item);
        if (id && recipeError(fields) === null) out.push({ id, ...fields });
      }
      return out;
    } catch {
      return [];
    }
  }

  private save(next: Recipe[]): void {
    try {
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, recipes: next }, null, 1));
      renameSync(tmp, this.deps.file);
    } catch (e) {
      throw new RecipeError(`The recipes could not be saved: ${(e as Error).message}`);
    }
    this.recipes = next;
  }

  list(): Recipe[] {
    return this.recipes.map((r) => ({ ...r, sessions: r.sessions.map((s) => ({ ...s })) }));
  }

  get(id: string): Recipe | null {
    return this.list().find((r) => r.id === id) ?? null;
  }

  create(input: unknown): Recipe {
    const fields = toRecipeFields(input);
    const problem = recipeError(fields);
    if (problem) throw new RecipeError(problem);
    const recipe: Recipe = { id: `recipe-${randomUUID().slice(0, 8)}`, ...fields };
    this.save([...this.recipes, recipe]);
    return recipe;
  }

  update(id: string, input: unknown): Recipe | null {
    if (!this.recipes.some((r) => r.id === id)) return null;
    const fields = toRecipeFields(input);
    const problem = recipeError(fields);
    if (problem) throw new RecipeError(problem);
    const recipe: Recipe = { id, ...fields };
    this.save(this.recipes.map((r) => (r.id === id ? recipe : r)));
    return recipe;
  }

  remove(id: string): boolean {
    if (!this.recipes.some((r) => r.id === id)) return false;
    this.save(this.recipes.filter((r) => r.id !== id));
    return true;
  }
}
