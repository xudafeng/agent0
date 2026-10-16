import { join, resolve } from 'node:path';
import {
  runAgentAutomationWake,
  type AgentAutomationWakeOptions,
  type AgentAutomationWakeResult,
} from './agent-automation-runtime.js';
import { runWakeCycle, type WakeCycleResult } from './background-runtime.js';
import { configuredComputerBackend } from './session-computer.js';
import { createFileSessionStore } from './session-store.js';
import { createFileWorkspaceStore } from './workspace.js';

export interface FullWakeCycleResult {
  wokeAt: string;
  automations: AgentAutomationWakeResult;
  background: WakeCycleResult;
  backgroundError?: string;
  nextWakeAt?: string;
}

function earliest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort()[0];
}

export async function runFullWakeCycle(
  profileDir: string,
  now: Date | string | number = new Date(),
  automationOptions: AgentAutomationWakeOptions = {},
): Promise<FullWakeCycleResult> {
  const wakeDate = new Date(now);
  if (!Number.isFinite(wakeDate.getTime())) throw new Error('Invalid wake time.');
  const profile = resolve(profileDir);
  const data = join(profile, 'data');

  const automations = await runAgentAutomationWake(profile, wakeDate, automationOptions);
  const sessions = createFileSessionStore(join(data, 'sessions'), join(data, 'session.json'));
  const workspaces = createFileWorkspaceStore(join(data, 'workspaces'));

  let background: WakeCycleResult = {
    wokeAt: wakeDate.toISOString(),
    sessions: [],
  };
  let backgroundError: string | undefined;

  try {
    const backend = configuredComputerBackend(workspaces);
    if (backend) {
      background = await runWakeCycle(sessions, workspaces, backend, wakeDate);
    }
  } catch (error) {
    backgroundError = error instanceof Error ? error.message : String(error);
  }

  const next = earliest([automations.nextWakeAt, background.nextWakeAt]);
  return {
    wokeAt: wakeDate.toISOString(),
    automations,
    background,
    ...(backgroundError === undefined ? {} : { backgroundError }),
    ...(next === undefined ? {} : { nextWakeAt: next }),
  };
}
