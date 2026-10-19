import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nextCronRunAt } from './scheduler.js';
import type { HeadlessPolicy } from './agent-run.js';

export type AgentAutomationState = 'enabled' | 'disabled';

export interface AgentAutomation {
  version: 1;
  automationId: string;
  name: string;
  state: AgentAutomationState;
  prompt: string;
  cwd: string;
  skillName?: string;
  skillRoots: string[];
  policy: HeadlessPolicy;
  nextRunAt: string;
  repeatEveryMs?: number;
  cronExpression?: string;
  timeZone?: string;
  runCount: number;
  lastAgentRunId?: string;
  runningAgentRunId?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
  maxRunMs?: number;
  consecutiveFailures?: number;
  backoffUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAutomationCreateInput {
  name?: string;
  prompt: string;
  cwd: string;
  skillName?: string;
  skillRoots?: string[];
  policy?: HeadlessPolicy;
  repeatEveryMs?: number;
  cronExpression?: string;
  timeZone?: string;
  maxRunMs?: number;
  now?: Date | string | number;
}

export interface AgentAutomationStore {
  create(input: AgentAutomationCreateInput): Promise<AgentAutomation>;
  get(automationId: string): Promise<AgentAutomation>;
  list(): Promise<AgentAutomation[]>;
  save(automation: AgentAutomation): Promise<void>;
  cancel(automationId: string): Promise<AgentAutomation>;
  enable(automationId: string, now?: Date | string | number): Promise<AgentAutomation>;
  claim(automationId: string): Promise<(() => Promise<void>) | undefined>;
}

interface AutomationIndex {
  version: 1;
  automationIds: string[];
}

export const DEFAULT_AUTOMATION_MAX_RUN_MS = 6 * 60 * 60 * 1000;

export function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface AutomationClaim {
  automationId: string;
  pid: number;
  claimedAt: string;
}

function validateClaim(value: unknown, automationId: string): AutomationClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Agent automation claim lock.');
  }
  const claim = value as Partial<AutomationClaim>;
  if (claim.automationId !== automationId || !Number.isInteger(claim.pid) ||
      (claim.pid ?? 0) <= 0 || typeof claim.claimedAt !== 'string') {
    throw new Error('Invalid Agent automation claim lock.');
  }
  parseTime(claim.claimedAt);
  return claim as AutomationClaim;
}

function assertId(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid agent automation ID.');
}

function normalizedText(value: string, name: string, max: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} cannot be empty.`);
  if (text.length > max) throw new Error(`${name} is too long.`);
  return text;
}

function parseTime(value: Date | string | number): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid automation time.');
  return date;
}

export function nextAgentAutomationRunAt(
  automation: Pick<AgentAutomation, 'repeatEveryMs' | 'cronExpression' | 'timeZone'>,
  currentDate: Date | string | number = new Date(),
): string {
  const now = parseTime(currentDate);
  if (automation.cronExpression !== undefined || automation.timeZone !== undefined) {
    if (!automation.cronExpression || !automation.timeZone) {
      throw new Error('Cron automation requires both cronExpression and timeZone.');
    }
    if (automation.repeatEveryMs !== undefined) {
      throw new Error('Automation cannot use both interval and cron recurrence.');
    }
    return nextCronRunAt(automation.cronExpression, automation.timeZone, now);
  }

  const interval = automation.repeatEveryMs;
  if (!Number.isFinite(interval) || !interval || interval <= 0) {
    throw new Error('Automation interval must be a positive number.');
  }
  return new Date(now.getTime() + interval).toISOString();
}

function validateAutomation(value: unknown, expectedId?: string): AgentAutomation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid agent automation.');
  }
  const item = value as Partial<AgentAutomation>;
  if (
    item.version !== 1 ||
    typeof item.automationId !== 'string' ||
    (expectedId !== undefined && item.automationId !== expectedId) ||
    typeof item.name !== 'string' ||
    !['enabled', 'disabled'].includes(item.state ?? '') ||
    typeof item.prompt !== 'string' ||
    typeof item.cwd !== 'string' ||
    !Array.isArray(item.skillRoots) ||
    item.skillRoots.some((root) => typeof root !== 'string') ||
    !['read-only', 'trusted-workspace'].includes(item.policy ?? '') ||
    typeof item.nextRunAt !== 'string' ||
    !Number.isInteger(item.runCount) ||
    (item.runCount ?? -1) < 0 ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string'
  ) {
    throw new Error('Invalid agent automation.');
  }
  assertId(item.automationId);
  parseTime(item.nextRunAt);

  if (item.skillName !== undefined && typeof item.skillName !== 'string') {
    throw new Error('Invalid agent automation skill.');
  }
  if (item.maxRunMs !== undefined &&
      (!Number.isFinite(item.maxRunMs) || item.maxRunMs <= 0 || item.maxRunMs > 7 * 24 * 60 * 60 * 1000)) {
    throw new Error('Invalid agent automation max run duration.');
  }
  if (item.consecutiveFailures !== undefined &&
      (!Number.isInteger(item.consecutiveFailures) || item.consecutiveFailures < 0)) {
    throw new Error('Invalid agent automation failure count.');
  }
  if (item.backoffUntil !== undefined) parseTime(item.backoffUntil);
  if (item.repeatEveryMs !== undefined &&
      (!Number.isFinite(item.repeatEveryMs) || item.repeatEveryMs <= 0)) {
    throw new Error('Invalid agent automation interval.');
  }
  if (item.cronExpression !== undefined || item.timeZone !== undefined) {
    if (typeof item.cronExpression !== 'string' || !item.cronExpression.trim() ||
        typeof item.timeZone !== 'string' || !item.timeZone.trim()) {
      throw new Error('Invalid agent automation cron schedule.');
    }
    if (item.repeatEveryMs !== undefined) {
      throw new Error('Agent automation cannot use both interval and cron recurrence.');
    }
    nextCronRunAt(item.cronExpression, item.timeZone, item.nextRunAt);
  } else if (item.repeatEveryMs === undefined) {
    throw new Error('Agent automation is missing recurrence.');
  }
  return item as AgentAutomation;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export function createFileAgentAutomationStore(root = 'data/agent-automations'): AgentAutomationStore {
  const indexPath = join(root, 'index.json');
  const pathFor = (id: string) => {
    assertId(id);
    return join(root, 'items', `${id}.json`);
  };
  const lockPath = (id: string) => {
    assertId(id);
    return join(root, 'locks', `${id}.lock`);
  };

  const readIndex = async (): Promise<AutomationIndex> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid agent automation index.');
      }
      const index = parsed as Partial<AutomationIndex>;
      if (index.version !== 1 || !Array.isArray(index.automationIds) ||
          index.automationIds.some((id) => typeof id !== 'string')) {
        throw new Error('Invalid agent automation index.');
      }
      return index as AutomationIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, automationIds: [] };
      }
      throw error;
    }
  };

  const load = async (automationId: string): Promise<AgentAutomation> => {
    try {
      return validateAutomation(
        JSON.parse(await readFile(pathFor(automationId), 'utf8')) as unknown,
        automationId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Agent automation not found: ${automationId}`);
      }
      throw error;
    }
  };

  const save = async (automation: AgentAutomation): Promise<void> => {
    const validated = validateAutomation(automation, automation.automationId);
    await atomicWrite(pathFor(automation.automationId), {
      ...validated,
      updatedAt: new Date().toISOString(),
    });
  };

  return {
    async create(input) {
      const now = parseTime(input.now ?? new Date());
      const hasInterval = input.repeatEveryMs !== undefined;
      const hasCron = input.cronExpression !== undefined || input.timeZone !== undefined;
      if (hasInterval === hasCron) {
        throw new Error('Agent automation requires exactly one recurrence: interval or cron.');
      }

      const recurrence = hasInterval
        ? { repeatEveryMs: input.repeatEveryMs! }
        : {
            cronExpression: normalizedText(input.cronExpression ?? '', 'Cron expression', 500),
            timeZone: normalizedText(input.timeZone ?? '', 'Cron timezone', 200),
          };
      const automationId = randomUUID();
      const createdAt = now.toISOString();
      const automation: AgentAutomation = {
        version: 1,
        automationId,
        name: normalizedText(input.name ?? input.skillName ?? 'Agent automation', 'Automation name', 200),
        state: 'enabled',
        prompt: normalizedText(input.prompt, 'Automation prompt', 32000),
        cwd: normalizedText(input.cwd, 'Automation cwd', 4000),
        ...(input.skillName?.trim() ? { skillName: input.skillName.trim() } : {}),
        skillRoots: (input.skillRoots ?? []).map((root) => normalizedText(root, 'Skill root', 4000)),
        policy: input.policy ?? 'read-only',
        maxRunMs: input.maxRunMs ?? DEFAULT_AUTOMATION_MAX_RUN_MS,
        consecutiveFailures: 0,
        ...recurrence,
        nextRunAt: nextAgentAutomationRunAt(recurrence, now),
        runCount: 0,
        createdAt,
        updatedAt: createdAt,
      };

      const index = await readIndex();
      index.automationIds.unshift(automationId);
      await Promise.all([
        save(automation),
        atomicWrite(indexPath, index),
      ]);
      return load(automationId);
    },

    get: load,

    async list() {
      const index = await readIndex();
      return Promise.all(index.automationIds.map(load));
    },

    save,

    async cancel(automationId) {
      const automation = await load(automationId);
      automation.state = 'disabled';
      await save(automation);
      return load(automationId);
    },

    async enable(automationId, now = new Date()) {
      const automation = await load(automationId);
      automation.state = 'enabled';
      automation.nextRunAt = nextAgentAutomationRunAt(automation, now);
      delete automation.lastError;
      await save(automation);
      return load(automationId);
    },

    async claim(automationId) {
      const path = lockPath(automationId);
      await mkdir(dirname(path), { recursive: true });

      const attempt = async (): Promise<(() => Promise<void>) | undefined> => {
        try {
          const handle = await open(path, 'wx');
          await handle.writeFile(`${JSON.stringify({
            automationId,
            pid: process.pid,
            claimedAt: new Date().toISOString(),
          })}\n`, 'utf8');
          await handle.close();

          let released = false;
          return async () => {
            if (released) return;
            released = true;
            await rm(path, { force: true });
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const claim = validateClaim(JSON.parse(await readFile(path, 'utf8')) as unknown, automationId);
          if (isProcessAlive(claim.pid)) return undefined;
          await rm(path, { force: true });
          return attempt();
        }
      };

      return attempt();
    },
  };
}
