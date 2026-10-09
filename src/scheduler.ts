import { randomUUID } from 'node:crypto';
import type { Computer } from './computer.js';
import { startDurableJob, type DurableJob } from './job.js';
import type { DetachedProcessStartInput } from './computer-process.js';

const INDEX_PATH = '.agent0/schedules/index.json';
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export type ScheduleState = 'pending' | 'starting' | 'started' | 'cancelled' | 'failed';

export interface ScheduledJob {
  scheduleId: string;
  runAt: string;
  state: ScheduleState;
  input: DetachedProcessStartInput;
  createdAt: string;
  startedAt?: string;
  jobId?: string;
  error?: string;
}

interface ScheduleIndex {
  version: 1;
  schedules: ScheduledJob[];
}

export interface DurableScheduler {
  schedule(input: DetachedProcessStartInput, runAt: string): Promise<ScheduledJob>;
  get(scheduleId: string): Promise<ScheduledJob>;
  list(): Promise<ScheduledJob[]>;
  cancel(scheduleId: string): Promise<ScheduledJob>;
  close(): Promise<void>;
}

function assertScheduleId(scheduleId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(scheduleId)) throw new Error('Invalid schedule ID.');
}

function parseRunAt(runAt: string): string {
  const date = new Date(runAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid schedule time.');
  return date.toISOString();
}

function validateIndex(parsed: unknown): ScheduleIndex {
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid schedule index.');
  const index = parsed as Partial<ScheduleIndex>;
  if (index.version !== 1 || !Array.isArray(index.schedules)) throw new Error('Invalid schedule index.');

  for (const schedule of index.schedules) {
    if (!schedule || typeof schedule !== 'object') throw new Error('Invalid schedule index.');
    const value = schedule as Partial<ScheduledJob>;
    if (typeof value.scheduleId !== 'string' || typeof value.runAt !== 'string' ||
        typeof value.createdAt !== 'string' ||
        !['pending', 'starting', 'started', 'cancelled', 'failed'].includes(value.state ?? '') ||
        !value.input || typeof value.input !== 'object') {
      throw new Error('Invalid schedule index.');
    }
    assertScheduleId(value.scheduleId);
    parseRunAt(value.runAt);
  }
  return index as ScheduleIndex;
}

export async function createDurableScheduler(computer: Computer): Promise<DurableScheduler> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  let index: ScheduleIndex = { version: 1, schedules: [] };
  let lock = Promise.resolve();

  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  };

  const exists = await computer.exec({
    command: 'sh',
    args: ['-lc', `test -f '${INDEX_PATH}'`],
  });
  if (exists.exitCode === 0) {
    index = validateIndex(JSON.parse(await computer.readTextFile(INDEX_PATH)) as unknown);
  } else {
    await computer.writeTextFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
  }

  const save = () => computer.writeTextFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);

  const clearTimer = (scheduleId: string) => {
    const timer = timers.get(scheduleId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(scheduleId);
  };

  const trigger = async (scheduleId: string): Promise<void> => {
    await exclusive(async () => {
      if (closed) return;
      const schedule = index.schedules.find((item) => item.scheduleId === scheduleId);
      if (!schedule || schedule.state !== 'pending') return;

      schedule.state = 'starting';
      schedule.startedAt = new Date().toISOString();
      await save();

      try {
        const job: DurableJob = await startDurableJob(computer, schedule.input);
        schedule.state = 'started';
        schedule.jobId = job.jobId;
      } catch (error) {
        schedule.state = 'failed';
        schedule.error = error instanceof Error ? error.message : String(error);
      }
      await save();
      clearTimer(scheduleId);
    });
  };

  const arm = (schedule: ScheduledJob) => {
    if (closed || schedule.state !== 'pending') return;
    clearTimer(schedule.scheduleId);
    const delay = new Date(schedule.runAt).getTime() - Date.now();
    if (delay <= 0) {
      queueMicrotask(() => { void trigger(schedule.scheduleId); });
      return;
    }
    const timer = setTimeout(() => {
      if (delay > MAX_TIMER_DELAY_MS) {
        arm(schedule);
        return;
      }
      void trigger(schedule.scheduleId);
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timers.set(schedule.scheduleId, timer);
  };

  for (const schedule of index.schedules) arm(schedule);

  return {
    async schedule(input, runAt) {
      return exclusive(async () => {
        if (closed) throw new Error('Scheduler is closed.');
        const normalizedRunAt = parseRunAt(runAt);
        if (new Date(normalizedRunAt).getTime() <= Date.now()) {
          throw new Error('Schedule time must be in the future.');
        }
        const schedule: ScheduledJob = {
          scheduleId: randomUUID(),
          runAt: normalizedRunAt,
          state: 'pending',
          input: structuredClone(input),
          createdAt: new Date().toISOString(),
        };
        index.schedules.unshift(schedule);
        await save();
        arm(schedule);
        return structuredClone(schedule);
      });
    },

    async get(scheduleId) {
      assertScheduleId(scheduleId);
      const schedule = index.schedules.find((item) => item.scheduleId === scheduleId);
      if (!schedule) throw new Error(`Unknown schedule: ${scheduleId}`);
      return structuredClone(schedule);
    },

    async list() {
      return structuredClone(index.schedules);
    },

    async cancel(scheduleId) {
      return exclusive(async () => {
        assertScheduleId(scheduleId);
        const schedule = index.schedules.find((item) => item.scheduleId === scheduleId);
        if (!schedule) throw new Error(`Unknown schedule: ${scheduleId}`);
        if (schedule.state !== 'pending') throw new Error(`Schedule is not cancellable: ${schedule.state}`);
        schedule.state = 'cancelled';
        clearTimer(scheduleId);
        await save();
        return structuredClone(schedule);
      });
    },

    async close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await lock;
    },
  };
}
