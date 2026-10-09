import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
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
  repeatEveryMs?: number;
  cronExpression?: string;
  timeZone?: string;
  runCount?: number;
}

interface ScheduleIndex {
  version: 1;
  schedules: ScheduledJob[];
}

export interface DurableScheduler {
  schedule(input: DetachedProcessStartInput, runAt: string, repeatEveryMs?: number): Promise<ScheduledJob>;
  scheduleCron(input: DetachedProcessStartInput, cronExpression: string, timeZone: string): Promise<ScheduledJob>;
  get(scheduleId: string): Promise<ScheduledJob>;
  list(): Promise<ScheduledJob[]>;
  cancel(scheduleId: string): Promise<ScheduledJob>;
  wake(now?: Date | string | number): Promise<{ triggered: string[]; nextWakeAt?: string }>;
  nextWakeAt(): string | undefined;
  close(): Promise<void>;
}

export interface DurableSchedulerOptions {
  armTimers?: boolean;
}

function assertScheduleId(scheduleId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(scheduleId)) throw new Error('Invalid schedule ID.');
}

function parseRunAt(runAt: string): string {
  const date = new Date(runAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid schedule time.');
  return date.toISOString();
}

export function nextCronRunAt(
  cronExpression: string,
  timeZone: string,
  currentDate: Date | string | number = new Date(),
): string {
  const expression = cronExpression.trim();
  const zone = timeZone.trim();
  if (!expression) throw new Error('Cron expression cannot be empty.');
  if (!zone) throw new Error('Cron timezone cannot be empty.');
  const interval = CronExpressionParser.parse(expression, {
    currentDate,
    tz: zone,
  });
  return interval.next().toDate().toISOString();
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
    if (value.repeatEveryMs !== undefined &&
        (!Number.isFinite(value.repeatEveryMs) || value.repeatEveryMs <= 0)) {
      throw new Error('Invalid schedule interval.');
    }
    if (value.cronExpression !== undefined || value.timeZone !== undefined) {
      if (typeof value.cronExpression !== 'string' || !value.cronExpression.trim() ||
          typeof value.timeZone !== 'string' || !value.timeZone.trim()) {
        throw new Error('Invalid cron schedule.');
      }
      if (value.repeatEveryMs !== undefined) throw new Error('Schedule cannot use both interval and cron recurrence.');
      nextCronRunAt(value.cronExpression, value.timeZone, new Date(value.runAt).getTime() - 1);
    }
    if (value.runCount !== undefined &&
        (!Number.isInteger(value.runCount) || value.runCount < 0)) {
      throw new Error('Invalid schedule run count.');
    }
  }
  return index as ScheduleIndex;
}

export async function createDurableScheduler(
  computer: Computer,
  options: DurableSchedulerOptions = {},
): Promise<DurableScheduler> {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const armTimers = options.armTimers ?? true;
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

  const probe = await computer.exec({
    command: 'sh',
    args: ['-lc', `if [ -f '${INDEX_PATH}' ]; then printf exists; else printf missing; fi`],
  });
  if (probe.exitCode === 0 && probe.stdout.trim() === 'exists') {
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
        schedule.jobId = job.jobId;
        schedule.runCount = (schedule.runCount ?? 0) + 1;
        delete schedule.error;

        if (schedule.cronExpression !== undefined && schedule.timeZone !== undefined) {
          schedule.state = 'pending';
          schedule.runAt = nextCronRunAt(schedule.cronExpression, schedule.timeZone);
        } else if (schedule.repeatEveryMs !== undefined) {
          schedule.state = 'pending';
          schedule.runAt = new Date(Date.now() + schedule.repeatEveryMs).toISOString();
        } else {
          schedule.state = 'started';
        }
      } catch (error) {
        schedule.state = 'failed';
        schedule.error = error instanceof Error ? error.message : String(error);
      }
      await save();
      clearTimer(scheduleId);
      if (schedule.state === 'pending') arm(schedule);
    });
  };

  const arm = (schedule: ScheduledJob) => {
    if (!armTimers || closed || schedule.state !== 'pending') return;
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

  const getNextWakeAt = (): string | undefined => {
    const pending = index.schedules
      .filter((schedule) => schedule.state === 'pending')
      .map((schedule) => schedule.runAt)
      .sort();
    return pending[0];
  };

  for (const schedule of index.schedules) arm(schedule);

  return {
    async schedule(input, runAt, repeatEveryMs) {
      return exclusive(async () => {
        if (closed) throw new Error('Scheduler is closed.');
        const normalizedRunAt = parseRunAt(runAt);
        if (new Date(normalizedRunAt).getTime() <= Date.now()) {
          throw new Error('Schedule time must be in the future.');
        }
        if (repeatEveryMs !== undefined &&
            (!Number.isFinite(repeatEveryMs) || repeatEveryMs <= 0)) {
          throw new Error('Schedule interval must be a positive number.');
        }
        const schedule: ScheduledJob = {
          scheduleId: randomUUID(),
          runAt: normalizedRunAt,
          state: 'pending',
          input: structuredClone(input),
          createdAt: new Date().toISOString(),
          ...(repeatEveryMs === undefined ? {} : { repeatEveryMs, runCount: 0 }),
        };
        index.schedules.unshift(schedule);
        await save();
        arm(schedule);
        return structuredClone(schedule);
      });
    },

    async scheduleCron(input, cronExpression, timeZone) {
      return exclusive(async () => {
        if (closed) throw new Error('Scheduler is closed.');
        const runAt = nextCronRunAt(cronExpression, timeZone);
        const schedule: ScheduledJob = {
          scheduleId: randomUUID(),
          runAt,
          state: 'pending',
          input: structuredClone(input),
          createdAt: new Date().toISOString(),
          cronExpression: cronExpression.trim(),
          timeZone: timeZone.trim(),
          runCount: 0,
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

    async wake(now = new Date()) {
      if (closed) throw new Error('Scheduler is closed.');
      const nowMs = new Date(now).getTime();
      if (!Number.isFinite(nowMs)) throw new Error('Invalid wake time.');

      const due = index.schedules
        .filter((schedule) =>
          schedule.state === 'pending' && new Date(schedule.runAt).getTime() <= nowMs
        )
        .sort((a, b) => a.runAt.localeCompare(b.runAt))
        .map((schedule) => schedule.scheduleId);

      const triggered: string[] = [];
      for (const scheduleId of due) {
        await trigger(scheduleId);
        triggered.push(scheduleId);
      }

      const nextWakeAt = getNextWakeAt();
      return {
        triggered,
        ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
      };
    },

    nextWakeAt() {
      return getNextWakeAt();
    },

    async close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await lock;
    },
  };
}
