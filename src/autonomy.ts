import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export type MissionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface MissionTask {
  id: string;
  title: string;
  status: MissionTaskStatus;
  dependsOn: string[];
  result?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MissionHandoff {
  id: string;
  reason: string;
  question: string;
  status: 'pending' | 'resolved';
  response?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface MissionEvaluation {
  score: number;
  summary: string;
  criteria: string[];
  createdAt: string;
}

export interface Mission {
  version: 1;
  id: string;
  goal: string;
  status: 'active' | 'completed' | 'blocked';
  tasks: MissionTask[];
  artifactIds: string[];
  handoff?: MissionHandoff;
  evaluation?: MissionEvaluation;
  createdAt: string;
  updatedAt: string;
}

export interface MissionStore {
  create(goal: string, tasks: Array<{ title: string; dependsOn?: number[] }>): Promise<Mission>;
  get(id: string): Promise<Mission>;
  list(): Promise<Mission[]>;
  updateTask(missionId: string, taskId: string, input: {
    status?: MissionTaskStatus;
    result?: string;
  }): Promise<MissionTask>;
  attachArtifact(missionId: string, artifactId: string): Promise<Mission>;
  requestHandoff(missionId: string, reason: string, question: string): Promise<MissionHandoff>;
  resolveHandoff(missionId: string, response: string): Promise<MissionHandoff>;
  setEvaluation(missionId: string, evaluation: Omit<MissionEvaluation, 'createdAt'>): Promise<Mission>;
}

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
  dependsOn: z.array(z.string()),
  result: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().optional(),
}).strict();

const handoffSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  question: z.string().min(1),
  status: z.enum(['pending', 'resolved']),
  response: z.string().optional(),
  createdAt: z.string().min(1),
  resolvedAt: z.string().optional(),
}).strict();

const evaluationSchema = z.object({
  score: z.number().min(0).max(1),
  summary: z.string().min(1),
  criteria: z.array(z.string()),
  createdAt: z.string().min(1),
}).strict();

const missionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  goal: z.string().min(1),
  status: z.enum(['active', 'completed', 'blocked']),
  tasks: z.array(taskSchema),
  artifactIds: z.array(z.string()),
  handoff: handoffSchema.optional(),
  evaluation: evaluationSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

function text(value: string, name: string, max = 8000): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error(`${name} cannot be empty.`);
  if (normalized.length > max) throw new Error(`${name} is too long.`);
  return normalized;
}


function validateDependencyGraph(tasks: Array<{ dependsOn?: number[] }>): void {
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (index: number) => {
    if (visiting.has(index)) throw new Error('Mission task dependencies contain a cycle.');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of tasks[index]?.dependsOn ?? []) {
      if (!Number.isInteger(dependency) || dependency < 0 || dependency >= tasks.length || dependency === index) {
        throw new Error(`Invalid task dependency index: ${dependency}`);
      }
      visit(dependency);
    }
    visiting.delete(index);
    visited.add(index);
  };

  for (let index = 0; index < tasks.length; index += 1) visit(index);
}

function missionStatus(tasks: MissionTask[], handoff?: MissionHandoff): Mission['status'] {
  if (handoff?.status === 'pending') return 'blocked';
  if (tasks.length > 0 && tasks.every((task) => task.status === 'completed')) return 'completed';
  if (tasks.some((task) => task.status === 'blocked')) return 'blocked';
  return 'active';
}

export function formatMission(mission: Mission | undefined): string {
  if (!mission) return '';
  const lines = [`Mission: ${mission.goal}`, `Status: ${mission.status}`];
  for (const task of mission.tasks) {
    const deps = task.dependsOn.length ? ` depends_on=${task.dependsOn.join(',')}` : '';
    lines.push(`- [${task.status}] [${task.id}] ${task.title}${deps}`);
    if (task.result) lines.push(`  Result: ${task.result}`);
  }
  if (mission.handoff?.status === 'pending') {
    lines.push(`Human handoff: ${mission.handoff.reason}`);
    lines.push(`Question: ${mission.handoff.question}`);
  }
  if (mission.artifactIds.length) lines.push(`Artifacts: ${mission.artifactIds.join(', ')}`);
  if (mission.evaluation) {
    lines.push(`Evaluation: ${mission.evaluation.score.toFixed(2)} — ${mission.evaluation.summary}`);
  }
  return lines.join('\n');
}

export function createFileMissionStore(root = 'data/autonomy'): MissionStore {
  const indexPath = join(root, 'index.json');
  const missionPath = (id: string) => join(root, 'missions', `${id}.json`);

  const readIndex = async (): Promise<string[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
        throw new Error('Invalid mission index.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  };

  const atomicWrite = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  };

  const load = async (id: string): Promise<Mission> => {
    try {
      return missionSchema.parse(JSON.parse(await readFile(missionPath(id), 'utf8'))) as Mission;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Mission not found: ${id}`);
      throw error;
    }
  };

  const save = async (mission: Mission): Promise<void> => {
    const next: Mission = { ...mission, updatedAt: new Date().toISOString() };
    await atomicWrite(missionPath(mission.id), next);
  };

  return {
    async create(goal, tasks) {
      if (!tasks.length) throw new Error('Mission requires at least one task.');
      validateDependencyGraph(tasks);
      const missionId = randomUUID();
      const now = new Date().toISOString();
      const ids = tasks.map(() => randomUUID());
      let firstReadyAssigned = false;
      const missionTasks: MissionTask[] = tasks.map((task, index) => {
        const dependencies = task.dependsOn ?? [];
        const ready = dependencies.length === 0;
        const status: MissionTaskStatus = ready && !firstReadyAssigned ? 'in_progress' : 'pending';
        if (status === 'in_progress') firstReadyAssigned = true;
        return {
        id: ids[index]!,
        title: text(task.title, 'Task', 1000),
        status,
        dependsOn: dependencies.map((dependency) => ids[dependency]!),
        createdAt: now,
        updatedAt: now,
      };
      });

      const mission: Mission = {
        version: 1,
        id: missionId,
        goal: text(goal, 'Mission goal', 2000),
        status: 'active',
        tasks: missionTasks,
        artifactIds: [],
        createdAt: now,
        updatedAt: now,
      };

      const index = await readIndex();
      index.unshift(missionId);
      await Promise.all([save(mission), atomicWrite(indexPath, index)]);
      return load(missionId);
    },

    get: load,

    async list() {
      const ids = await readIndex();
      return Promise.all(ids.map(load));
    },

    async updateTask(missionId, taskId, input) {
      const mission = await load(missionId);
      const index = mission.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) throw new Error(`Mission task not found: ${taskId}`);
      const current = mission.tasks[index]!;

      if (input.status === 'in_progress') {
        const unmet = current.dependsOn.filter((dependency) =>
          mission.tasks.find((task) => task.id === dependency)?.status !== 'completed'
        );
        if (unmet.length) throw new Error(`Task dependencies are not complete: ${unmet.join(', ')}`);
      }

      const now = new Date().toISOString();
      const { completedAt: _completedAt, result: _result, ...base } = current;
      const status = input.status ?? current.status;
      const updated: MissionTask = {
        ...base,
        status,
        updatedAt: now,
        ...((input.result ?? current.result) === undefined ? {} : { result: input.result ?? current.result }),
        ...(status === 'completed' ? { completedAt: current.completedAt ?? now } : {}),
      };
      mission.tasks[index] = updated;

      if (status === 'completed') {
        for (const candidate of mission.tasks) {
          if (candidate.status !== 'pending') continue;
          const ready = candidate.dependsOn.every((dependency) =>
            mission.tasks.find((task) => task.id === dependency)?.status === 'completed'
          );
          if (ready) {
            candidate.status = 'in_progress';
            candidate.updatedAt = now;
            break;
          }
        }
      }

      mission.status = missionStatus(mission.tasks, mission.handoff);
      await save(mission);
      return structuredClone(updated);
    },

    async attachArtifact(missionId, artifactId) {
      const mission = await load(missionId);
      if (!mission.artifactIds.includes(artifactId)) mission.artifactIds.push(artifactId);
      await save(mission);
      return load(missionId);
    },

    async requestHandoff(missionId, reason, question) {
      const mission = await load(missionId);
      const handoff: MissionHandoff = {
        id: randomUUID(),
        reason: text(reason, 'Handoff reason', 2000),
        question: text(question, 'Handoff question', 4000),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      mission.handoff = handoff;
      mission.status = 'blocked';
      await save(mission);
      return structuredClone(handoff);
    },

    async resolveHandoff(missionId, response) {
      const mission = await load(missionId);
      if (!mission.handoff || mission.handoff.status !== 'pending') {
        throw new Error('Mission has no pending human handoff.');
      }
      mission.handoff = {
        ...mission.handoff,
        status: 'resolved',
        response: text(response, 'Handoff response', 8000),
        resolvedAt: new Date().toISOString(),
      };
      mission.status = missionStatus(mission.tasks, mission.handoff);
      await save(mission);
      return structuredClone(mission.handoff);
    },

    async setEvaluation(missionId, evaluation) {
      const mission = await load(missionId);
      mission.evaluation = {
        score: evaluation.score,
        summary: text(evaluation.summary, 'Evaluation summary', 4000),
        criteria: evaluation.criteria.map((criterion) => text(criterion, 'Evaluation criterion', 1000)),
        createdAt: new Date().toISOString(),
      };
      await save(mission);
      return load(missionId);
    },
  };
}
