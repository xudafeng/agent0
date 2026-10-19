import { join, resolve } from 'node:path';
import {
  createFileAgentAutomationStore,
  isProcessAlive,
  nextAgentAutomationRunAt,
  type AgentAutomation,
  type AgentAutomationStore,
} from './agent-automation.js';
import { createFileAgentRunStore } from './agent-run-store.js';
import {
  runHeadlessAgent,
  type HeadlessAgentRunOptions,
  type HeadlessAgentRunResult,
} from './agent-run.js';

export interface AgentAutomationWakeItem {
  automationId: string;
  status: 'completed' | 'failed' | 'skipped';
  agentRunId?: string;
  reason?: string;
  error?: string;
  nextRunAt?: string;
}

export interface AgentAutomationWakeResult {
  wokeAt: string;
  automations: AgentAutomationWakeItem[];
  nextWakeAt?: string;
}

export interface AgentAutomationWakeOptions {
  store?: AgentAutomationStore;
  execute?: (options: HeadlessAgentRunOptions) => Promise<HeadlessAgentRunResult>;
}

const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export class AgentAutomationTimeoutError extends Error {
  constructor(
    public readonly automationId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Agent automation timed out after ${timeoutMs} ms: ${automationId}`);
    this.name = 'AgentAutomationTimeoutError';
  }
}

function failureBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 10));
  return Math.min(FAILURE_BACKOFF_BASE_MS * (2 ** exponent), FAILURE_BACKOFF_MAX_MS);
}

function due(automation: AgentAutomation, now: Date): boolean {
  return automation.state === 'enabled' &&
    new Date(automation.nextRunAt).getTime() <= now.getTime();
}

function nextWakeAt(automations: AgentAutomation[]): string | undefined {
  return automations
    .filter((automation) => automation.state === 'enabled')
    .map((automation) => automation.nextRunAt)
    .sort()[0];
}

export async function runAgentAutomationWake(
  profileDir: string,
  now: Date | string | number = new Date(),
  options: AgentAutomationWakeOptions = {},
): Promise<AgentAutomationWakeResult> {
  const wakeDate = new Date(now);
  if (!Number.isFinite(wakeDate.getTime())) throw new Error('Invalid automation wake time.');
  const profile = resolve(profileDir);
  const store = options.store ??
    createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const agentRuns = createFileAgentRunStore(join(profile, 'data', 'agent-runs'));
  const execute = options.execute ?? runHeadlessAgent;
  const current = await store.list();
  const dueAutomations = current
    .filter((automation) => due(automation, wakeDate) || automation.runningAgentRunId !== undefined)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  const results: AgentAutomationWakeItem[] = [];

  for (const scheduled of dueAutomations) {
    const release = await store.claim(scheduled.automationId);
    if (!release) {
      results.push({
        automationId: scheduled.automationId,
        status: 'skipped',
        reason: 'automation is already claimed by another worker',
        nextRunAt: scheduled.nextRunAt,
      });
      continue;
    }

    try {
      let automation = await store.get(scheduled.automationId);
      if (!due(automation, wakeDate)) {
        results.push({
          automationId: automation.automationId,
          status: 'skipped',
          reason: automation.state !== 'enabled' ? 'automation is disabled' : 'automation is no longer due',
          nextRunAt: automation.nextRunAt,
        });
        continue;
      }

      let resumeAgentRunId: string | undefined;
      if (automation.runningAgentRunId) {
        const running = await agentRuns.load(automation.runningAgentRunId);
        if (running?.status === 'running') {
          if (running.ownerPid === undefined) {
            results.push({
              automationId: automation.automationId,
              status: 'skipped',
              agentRunId: running.agentRunId,
              reason: 'previous AgentRun ownership is unknown',
              nextRunAt: automation.nextRunAt,
            });
            continue;
          }
          if (isProcessAlive(running.ownerPid)) {
            results.push({
              automationId: automation.automationId,
              status: 'skipped',
              agentRunId: running.agentRunId,
              reason: 'previous AgentRun is still running',
              nextRunAt: automation.nextRunAt,
            });
            continue;
          }
          if (running.runtimeRunId) {
            resumeAgentRunId = running.agentRunId;
          } else {
            const failedAt = new Date().toISOString();
            running.status = 'failed';
            running.error = 'Owner process exited before a resumable runtime checkpoint was recorded.';
            running.completedAt = failedAt;
            running.updatedAt = failedAt;
            running.heartbeatAt = failedAt;
            delete running.ownerPid;
            await agentRuns.save(running);
            delete automation.runningAgentRunId;
            automation.lastError = running.error;
            await store.save(automation);
          }
        } else {
          delete automation.runningAgentRunId;
          await store.save(automation);
        }
      }

      if (!resumeAgentRunId && !due(automation, wakeDate)) {
        results.push({
          automationId: automation.automationId,
          status: 'skipped',
          reason: 'stale run reconciled; automation is not currently due',
          nextRunAt: automation.nextRunAt,
        });
        continue;
      }

      if (!resumeAgentRunId) {
        // Advance before a new execution so a missed interval is caught up once
        // rather than replayed repeatedly after a long sleep or normal failure.
        automation.nextRunAt = nextAgentAutomationRunAt(automation, wakeDate);
        delete automation.lastError;
        await store.save(automation);
      }

      const timeoutMs = automation.maxRunMs ?? 6 * 60 * 60 * 1000;
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        timeoutController.abort(new AgentAutomationTimeoutError(automation.automationId, timeoutMs));
      }, timeoutMs);

      try {
        const result = await execute({
          profileDir: profile,
          ...(resumeAgentRunId === undefined ? { prompt: automation.prompt } : {}),
          ...(resumeAgentRunId === undefined ? { cwd: automation.cwd } : {}),
          ...(resumeAgentRunId === undefined && automation.skillName !== undefined ? { skillName: automation.skillName } : {}),
          ...(resumeAgentRunId === undefined ? { skillRoots: [...automation.skillRoots] } : {}),
          ...(resumeAgentRunId === undefined ? { policy: automation.policy, trigger: 'scheduled' as const } : {}),
          ...(resumeAgentRunId === undefined ? {} : { resumeAgentRunId }),
          signal: timeoutController.signal,
          ...(resumeAgentRunId === undefined ? {
            onAgentRunCreated: async (record) => {
              const latest = await store.get(automation.automationId);
              latest.runningAgentRunId = record.agentRunId;
              latest.lastAgentRunId = record.agentRunId;
              latest.lastStartedAt = new Date().toISOString();
              latest.runCount += 1;
              delete latest.lastError;
              await store.save(latest);
            },
          } : {}),
        });

        automation = await store.get(automation.automationId);
        delete automation.runningAgentRunId;
        automation.lastAgentRunId = result.record.agentRunId;
        automation.lastCompletedAt = new Date().toISOString();
        automation.consecutiveFailures = 0;
        delete automation.backoffUntil;
        delete automation.lastError;
        await store.save(automation);
        results.push({
          automationId: automation.automationId,
          status: 'completed',
          agentRunId: result.record.agentRunId,
          nextRunAt: automation.nextRunAt,
        });
      } catch (error) {
        automation = await store.get(automation.automationId);
        delete automation.runningAgentRunId;
        const failedAt = new Date();
        automation.lastCompletedAt = failedAt.toISOString();
        automation.lastError = error instanceof Error ? error.message : String(error);
        automation.consecutiveFailures = (automation.consecutiveFailures ?? 0) + 1;
        const backoffUntil = new Date(
          failedAt.getTime() + failureBackoffMs(automation.consecutiveFailures),
        ).toISOString();
        automation.backoffUntil = backoffUntil;
        if (backoffUntil > automation.nextRunAt) automation.nextRunAt = backoffUntil;
        await store.save(automation);
        results.push({
          automationId: automation.automationId,
          status: 'failed',
          ...(automation.lastAgentRunId === undefined ? {} : { agentRunId: automation.lastAgentRunId }),
          error: automation.lastError,
          nextRunAt: automation.nextRunAt,
        });
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await release();
    }
  }

  const latest = await store.list();
  const next = nextWakeAt(latest);
  return {
    wokeAt: wakeDate.toISOString(),
    automations: results,
    ...(next === undefined ? {} : { nextWakeAt: next }),
  };
}
