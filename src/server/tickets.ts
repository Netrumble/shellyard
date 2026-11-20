import type { CreateSessionRequest, Profile, SessionInfo, Story, WorktreeListing } from '../shared/types.js';
import { planTicket, type Recipe, type TicketPlan } from '../shared/recipes.js';

// Starts the work on a ticket in one step: the worktree on its branch, an area in it, and the
// sessions of the recipe there, each Claude one given its prompt once it is ready. Only the
// worktree is undone when a later step fails: the sessions, once started, are the user's.

export class TicketError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface TicketDeps {
  recipe: (id: string) => Recipe | null;
  stories: { list(): Story[]; create(input: { name: string; ticket: string; cwd: string }): Story };
  profiles: () => Profile[];
  createSession: (req: CreateSessionRequest) => SessionInfo;
  deliverPrompt: (sessionId: string, prompt: string) => void;
  git: {
    branches(folder: string): Promise<string[]>;
    createWorktree(repo: string, o: { path: string; branch: string; newBranch: boolean; base?: string }): Promise<WorktreeListing>;
    removeWorktree(repo: string, path: string, o: { force: boolean; deleteBranch: boolean }): Promise<unknown>;
  };
  /** Turns a git failure into the message to show, or rethrows what is not one. */
  gitMessage: (e: unknown) => string;
  refreshGit: (repo: string) => Promise<void>;
}

export interface TicketStart {
  plan: TicketPlan;
  story: Story;
  sessions: SessionInfo[];
  /** True when the branch was made for this ticket; false when an existing one was checked out. */
  newBranch: boolean;
}

export async function startFromTicket(deps: TicketDeps, recipeId: string, rawTicket: string): Promise<TicketStart> {
  const recipe = deps.recipe(recipeId);
  if (!recipe) throw new TicketError(404, 'No such recipe');
  const plan = planTicket(recipe, rawTicket);
  if ('error' in plan) throw new TicketError(400, plan.error);

  const taken = deps.stories.list().find((s) => s.ticket.toUpperCase() === plan.ticket);
  if (taken) throw new TicketError(409, `There is already an area for ${plan.ticket}: "${taken.name}".`);
  const known = new Set(deps.profiles().map((p) => p.id));
  const missing = plan.sessions.find((s) => !known.has(s.profileId));
  if (missing) throw new TicketError(409, `The recipe starts the launcher "${missing.profileId}", which no longer exists. Edit the recipe.`);

  // A branch that already exists (the ticket was started elsewhere before) is checked out as is.
  const newBranch = !(await deps.git.branches(plan.repo)).includes(plan.branch);
  try {
    await deps.git.createWorktree(plan.repo, { path: plan.worktree, branch: plan.branch, newBranch, base: newBranch ? plan.base : undefined });
  } catch (e) {
    throw new TicketError(409, deps.gitMessage(e));
  }

  let story: Story;
  try {
    story = deps.stories.create({ name: plan.areaName, ticket: plan.ticket, cwd: plan.worktree });
  } catch (e) {
    // Nothing runs in the new worktree yet: take it away again, with the branch made for it.
    await deps.git.removeWorktree(plan.repo, plan.worktree, { force: false, deleteBranch: newBranch }).catch(() => undefined);
    throw new TicketError(409, `The area could not be made: ${(e as Error).message}`);
  }

  const sessions = plan.sessions.map((s) => {
    const session = deps.createSession({ profileId: s.profileId, storyId: story.id, cwd: plan.worktree, ...(s.model ? { model: s.model } : {}) });
    if (s.prompt.trim() && session.kind === 'claude' && session.status !== 'exited') deps.deliverPrompt(session.id, s.prompt);
    return session;
  });
  await deps.refreshGit(plan.repo).catch(() => undefined);
  return { plan, story, sessions, newBranch };
}
