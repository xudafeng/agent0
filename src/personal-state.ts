import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export type PersonalTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface PersonalGoal {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalTask {
  id: string;
  title: string;
  status: PersonalTaskStatus;
  goalId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface PersonalState {
  version: 1;
  dailyFocus: string;
  goals: PersonalGoal[];
  tasks: PersonalTask[];
  notes: string[];
  updatedAt: string;
}

export interface PersonalStateStore {
  get(): Promise<PersonalState>;
  setDailyFocus(value: string): Promise<PersonalState>;
  addGoal(title: string): Promise<PersonalGoal>;
  removeGoal(id: string): Promise<void>;
  addTask(title: string, goalId?: string): Promise<PersonalTask>;
  updateTask(id: string, input: { title?: string; status?: PersonalTaskStatus; goalId?: string | null }): Promise<PersonalTask>;
  addNote(content: string): Promise<PersonalState>;
  clearDaily(): Promise<PersonalState>;
  appendDailyJournal(content: string, date?: Date): Promise<string>;
}

const stateSchema = z.object({
  version: z.literal(1),
  dailyFocus: z.string(),
  goals: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })),
  tasks: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
    goalId: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
  })),
  notes: z.array(z.string()),
  updatedAt: z.string().min(1),
}).strict();

function text(value: string, name: string, limit = 4000): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error(`${name} cannot be empty.`);
  if (normalized.length > limit) throw new Error(`${name} is too long.`);
  return normalized;
}

function emptyState(): PersonalState {
  return {
    version: 1,
    dailyFocus: '',
    goals: [],
    tasks: [],
    notes: [],
    updatedAt: new Date().toISOString(),
  };
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatPersonalState(state: PersonalState): string {
  const lines: string[] = [];
  if (state.dailyFocus) lines.push(`Daily focus: ${state.dailyFocus}`);

  const activeGoals = state.goals.slice(0, 8);
  if (activeGoals.length) {
    lines.push('Goals:');
    for (const goal of activeGoals) lines.push(`- [${goal.id}] ${goal.title}`);
  }

  const activeTasks = state.tasks.filter((task) => task.status !== 'completed').slice(0, 12);
  if (activeTasks.length) {
    lines.push('Active tasks:');
    for (const task of activeTasks) {
      lines.push(`- [${task.status}] [${task.id}] ${task.title}`);
    }
  }

  if (state.notes.length) {
    lines.push('Daily notes:');
    for (const note of state.notes.slice(-6)) lines.push(`- ${note}`);
  }

  return lines.join('\n');
}

export function createFilePersonalStateStore(root = 'data/personal'): PersonalStateStore {
  const statePath = join(root, 'state.json');

  const load = async (): Promise<PersonalState> => {
    try {
      return stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state = emptyState();
      await save(state);
      return state;
    }
  };

  const save = async (state: PersonalState): Promise<void> => {
    await mkdir(dirname(statePath), { recursive: true });
    const next = { ...state, updatedAt: new Date().toISOString() };
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporary, statePath);
  };

  return {
    get: load,

    async setDailyFocus(value) {
      const state = await load();
      state.dailyFocus = value.trim() ? text(value, 'Daily focus', 1000) : '';
      await save(state);
      return load();
    },

    async addGoal(title) {
      const state = await load();
      const now = new Date().toISOString();
      const goal: PersonalGoal = {
        id: randomUUID(),
        title: text(title, 'Goal', 500),
        createdAt: now,
        updatedAt: now,
      };
      state.goals.push(goal);
      await save(state);
      return structuredClone(goal);
    },

    async removeGoal(id) {
      const state = await load();
      if (!state.goals.some((goal) => goal.id === id)) throw new Error(`Goal not found: ${id}`);
      state.goals = state.goals.filter((goal) => goal.id !== id);
      state.tasks = state.tasks.map((task) =>
        task.goalId === id ? { ...task, goalId: undefined } : task
      );
      await save(state);
    },

    async addTask(title, goalId) {
      const state = await load();
      if (goalId !== undefined && !state.goals.some((goal) => goal.id === goalId)) {
        throw new Error(`Goal not found: ${goalId}`);
      }
      const now = new Date().toISOString();
      const task: PersonalTask = {
        id: randomUUID(),
        title: text(title, 'Task', 1000),
        status: 'pending',
        ...(goalId === undefined ? {} : { goalId }),
        createdAt: now,
        updatedAt: now,
      };
      state.tasks.push(task);
      await save(state);
      return structuredClone(task);
    },

    async updateTask(id, input) {
      const state = await load();
      const index = state.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error(`Task not found: ${id}`);
      const current = state.tasks[index]!;
      const goalId = input.goalId === null ? undefined : input.goalId ?? current.goalId;
      if (goalId !== undefined && !state.goals.some((goal) => goal.id === goalId)) {
        throw new Error(`Goal not found: ${goalId}`);
      }
      const status = input.status ?? current.status;
      const now = new Date().toISOString();
      const updated: PersonalTask = {
        ...current,
        ...(input.title === undefined ? {} : { title: text(input.title, 'Task', 1000) }),
        status,
        ...(goalId === undefined ? { goalId: undefined } : { goalId }),
        updatedAt: now,
        ...(status === 'completed'
          ? { completedAt: current.completedAt ?? now }
          : { completedAt: undefined }),
      };
      state.tasks[index] = updated;
      await save(state);
      return structuredClone(updated);
    },

    async addNote(content) {
      const state = await load();
      state.notes.push(text(content, 'Note', 2000));
      state.notes = state.notes.slice(-20);
      await save(state);
      return load();
    },

    async clearDaily() {
      const state = await load();
      state.dailyFocus = '';
      state.notes = [];
      await save(state);
      return load();
    },

    async appendDailyJournal(content, date = new Date()) {
      const value = content.trim();
      if (!value) throw new Error('Daily journal entry cannot be empty.');
      const key = dateKey(date);
      const path = join(root, 'daily', `${key}.md`);
      await mkdir(dirname(path), { recursive: true });
      let existing = `# ${key}\n\n`;
      try {
        existing = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const timestamp = date.toISOString();
      await writeFile(path, `${existing.trimEnd()}\n\n## ${timestamp}\n\n${value}\n`, 'utf8');
      return path;
    },
  };
}
