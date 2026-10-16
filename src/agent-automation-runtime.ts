import { join, resolve } from 'node:path';
import {
  createFileAgentAutomationStore,
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
    .filter((automation) => due(automation, wakeDate))
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

      if (automation.runningAgentRunId) {
        const running = await agentRuns.load(automation.runningAgentRunId);
        if (running?.status === 'running') {
          results.push({
            automationId: automation.automationId,
            status: 'skipped',
            agentRunId: running.agentRunId,
            reason: 'previous AgentRun is still running',
            nextRunAt: automation.nextRunAt,
          });
          continue;
        }
        delete automation.runningAgentRunId;
      }

      // Advance before execution so a missed interval is caught up once rather
      // than replayed repeatedly after a long sleep or a normal failure.
      automation.nextRunAt = nextAgentAutomationRunAt(automation, wakeDate);
      delete automation.lastError;
      await store.save(automation);

      try {
        const result = await execute({
          profileDir: profile,
          prompt: automation.prompt,
          cwd: automation.cwd,
          ...(automation.skillName === undefined ? {} : { skillName: automation.skillName }),
          skillRoots: [...automation.skillRoots],
          policy: automation.policy,
          trigger: 'scheduled',
          onAgentRunCreated: async (record) => {
            const latest = await store.get(automation.automationId);
            latest.runningAgentRunId = record.agentRunId;
            latest.lastAgentRunId = record.agentRunId;
            latest.lastStartedAt = new Date().toISOString();
            latest.runCount += 1;
            delete latest.lastError;
            await store.save(latest);
          },
        });

        automation = await store.get(automation.automationId);
        delete automation.runningAgentRunId;
        automation.lastAgentRunId = result.record.agentRunId;
        automation.lastCompletedAt = new Date().toISOString();
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
        automation.lastCompletedAt = new Date().toISOString();
        automation.lastError = error instanceof Error ? error.message : String(error);
        await store.save(automation);
        results.push({
          automationId: automation.automationId,
          status: 'failed',
          ...(automation.lastAgentRunId === undefined ? {} : { agentRunId: automation.lastAgentRunId }),
          error: automation.lastError,
          nextRunAt: automation.nextRunAt,
        });
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
