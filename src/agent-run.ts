import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentEvent, AgentEventHandler } from './events.js';
import { createFileAgentRunStore, type AgentRunRecord, type AgentRunTrigger } from './agent-run-store.js';
import { createFileArtifactStore } from './artifact.js';
import { createFileAgentAutomationStore } from './agent-automation.js';
import { createFileMissionStore } from './autonomy.js';
import type { ExaClient } from './exa.js';
import { createFileToolExecutionLedger } from './execution-ledger.js';
import { createLocalDirectoryComputer } from './local-computer.js';
import { createFileMemoryStore } from './memory.js';
import { createFilePersonalStateStore } from './personal-state.js';
import type { Provider } from './provider.js';
import { createFileRunStore } from './run-store.js';
import { createAgentRuntime } from './runtime.js';
import { createFileSessionStore, type SessionHistoryMessage } from './session-store.js';
import type { ToolExecutionPolicy } from './tools.js';

export type HeadlessPolicy = 'read-only' | 'trusted-workspace';

export interface HeadlessAgentRunOptions {
  profileDir: string;
  prompt?: string;
  cwd?: string;
  skillName?: string;
  skillRoots?: string[];
  sessionId?: string;
  trigger?: AgentRunTrigger;
  policy?: HeadlessPolicy;
  resumeAgentRunId?: string;
  signal?: AbortSignal;
  onEvent?: AgentEventHandler;
  onAgentRunCreated?: (record: AgentRunRecord) => Promise<void> | void;
  provider?: Provider;
  exaClient?: ExaClient | null;
}

export interface HeadlessAgentRunResult {
  record: AgentRunRecord;
  text: string;
  steps: number;
}

const headlessAlwaysDenied = new Set([
  'schedule_agent_run',
  'agent_automation_cancel',
  'agent_automation_enable',
]);

const readOnlyDenied = new Set([
  'computer_exec',
  'computer_write_file',
  'computer_start_process',
  'job_start',
  'schedule_create',
  'schedule_create_cron',
  'schedule_cancel',
  'memory_remember',
  'memory_update',
  'memory_forget',
  'personal_set_focus',
  'personal_add_goal',
  'personal_remove_goal',
  'personal_add_task',
  'personal_update_task',
  'personal_add_note',
  'personal_journal',
  'autonomy_create_mission',
  'autonomy_update_task',
  'autonomy_delegate_parallel',
  'autonomy_request_handoff',
  'autonomy_evaluate',
  'artifact_create',
]);

export function createHeadlessToolPolicy(policy: HeadlessPolicy): ToolExecutionPolicy {
  return (toolCall) => {
    if (toolCall.name.startsWith('mcp_')) {
      return { action: 'deny', reason: 'MCP tools are disabled in non-interactive headless runs.' };
    }
    if (headlessAlwaysDenied.has(toolCall.name)) {
      return { action: 'deny', reason: 'Scheduled Agent automation changes require an interactive approval or explicit CLI action.' };
    }
    if (policy === 'read-only' && readOnlyDenied.has(toolCall.name)) {
      return { action: 'deny', reason: `Tool is not allowed by the read-only headless policy: ${toolCall.name}` };
    }
    return { action: 'allow' };
  };
}

function mergeSkills(existing: string[], skillName?: string): string[] {
  if (!skillName || existing.includes(skillName)) return [...existing];
  return [...existing, skillName];
}

function validatePrompt(prompt: string | undefined): string {
  const value = prompt?.trim();
  if (!value) throw new Error('Headless agent run requires a non-empty prompt.');
  if (value.length > 32000) throw new Error('Headless agent prompt cannot exceed 32000 characters.');
  return value;
}

export async function runHeadlessAgent(options: HeadlessAgentRunOptions): Promise<HeadlessAgentRunResult> {
  const profileDir = resolve(options.profileDir);
  await mkdir(profileDir, { recursive: true });
  const dataDir = join(profileDir, 'data');
  const sessionStore = createFileSessionStore(
    join(dataDir, 'headless-sessions'),
    join(dataDir, 'headless-session.json'),
  );
  const agentRuns = createFileAgentRunStore(join(dataDir, 'agent-runs'));
  const runtimeRuns = createFileRunStore(join(dataDir, 'runs'));
  const executionLedger = createFileToolExecutionLedger(join(dataDir, 'executions'));
  const memoryStore = createFileMemoryStore(join(dataDir, 'memory'), join(dataDir, 'memory.md'));
  const personalStateStore = createFilePersonalStateStore(join(dataDir, 'personal'));
  const missionStore = createFileMissionStore(join(dataDir, 'autonomy'));
  const artifactStore = createFileArtifactStore(join(dataDir, 'artifacts'));
  const agentAutomationStore = createFileAgentAutomationStore(join(dataDir, 'agent-automations'));
  const tracePath = join(dataDir, 'traces.ndjson');

  let record: AgentRunRecord;
  let prompt: string;
  let sessionId: string;
  let cwd: string | undefined;
  let skillName: string | undefined;
  let skillRoots: string[];
  let policy: HeadlessPolicy;
  let resumeRuntimeRunId: string | undefined;
  let history: SessionHistoryMessage[] = [];

  if (options.resumeAgentRunId) {
    const existing = await agentRuns.load(options.resumeAgentRunId);
    if (!existing) throw new Error(`Agent run not found: ${options.resumeAgentRunId}`);
    if (existing.status !== 'running') {
      throw new Error(`Agent run is not resumable: ${existing.status}`);
    }
    if (!existing.runtimeRunId) throw new Error('Agent run is missing its runtime run ID.');
    record = existing;
    prompt = existing.prompt;
    sessionId = existing.sessionId;
    cwd = existing.cwd;
    skillName = existing.skillName;
    skillRoots = [...existing.skillRoots];
    policy = existing.policy;
    resumeRuntimeRunId = existing.runtimeRunId;
  } else {
    prompt = validatePrompt(options.prompt);
    const requestedSession = options.sessionId?.trim();
    if (requestedSession) {
      const existing = await sessionStore.load(requestedSession);
      if (!existing) throw new Error(`Headless session not found: ${requestedSession}`);
      sessionId = requestedSession;
    } else {
      sessionId = (await sessionStore.create(prompt.slice(0, 80))).id;
    }
    cwd = options.cwd ? resolve(options.cwd) : undefined;
    skillName = options.skillName?.trim() || undefined;
    skillRoots = (options.skillRoots ?? []).map((root) => resolve(root));
    policy = options.policy ?? 'read-only';
    record = await agentRuns.create({
      trigger: options.trigger ?? 'manual',
      status: 'running',
      prompt,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(skillName === undefined ? {} : { skillName }),
      skillRoots,
      policy,
    });
    await options.onAgentRunCreated?.(structuredClone(record));
  }

  const snapshot = await sessionStore.load(sessionId);
  history = snapshot ? structuredClone(snapshot.history) : [];

  const computer = cwd ? await createLocalDirectoryComputer(cwd) : undefined;
  const runtime = await createAgentRuntime({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.exaClient === undefined ? {} : { exaClient: options.exaClient }),
    ...(computer === undefined ? {} : { computer }),
    enableScheduler: false,
    memoryStore,
    personalStateStore,
    missionStore,
    artifactStore,
    agentAutomationStore,
    runStore: runtimeRuns,
    executionLedger,
    tracePath,
    skillRoots,
    toolPolicy: createHeadlessToolPolicy(policy),
  });

  try {
    if (!resumeRuntimeRunId) {
      const prior = snapshot?.runtime ?? { messages: [], skills: [] };
      await runtime.restoreSession({
        messages: structuredClone(prior.messages),
        ...(prior.task === undefined ? {} : { task: structuredClone(prior.task) }),
        skills: mergeSkills(prior.skills, skillName),
      });
    }

    const onEvent = async (event: AgentEvent) => {
      if (!record.runtimeRunId && event.type === 'run_start') {
        record = { ...record, runtimeRunId: event.runId };
        await agentRuns.save(record);
      }
      await options.onEvent?.(event);
    };

    const runOptions = {
      onEvent,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const result = resumeRuntimeRunId
      ? await runtime.resume(resumeRuntimeRunId, runOptions)
      : await runtime.run(prompt, runOptions);

    history.push(
      { role: 'user', content: prompt },
      { role: 'assistant', content: result.text, steps: result.steps },
    );
    const now = new Date().toISOString();
    await sessionStore.save(sessionId, {
      version: 1,
      history,
      runtime: runtime.getSessionState(),
      updatedAt: now,
    });

    record = {
      ...record,
      status: 'completed',
      runtimeRunId: result.runId,
      result: result.text,
      completedAt: now,
      updatedAt: now,
    };
    delete record.error;
    await agentRuns.save(record);
    return { record, text: result.text, steps: result.steps };
  } catch (error) {
    const cancelled = Boolean(options.signal?.aborted);
    const now = new Date().toISOString();
    record = {
      ...record,
      status: cancelled ? 'cancelled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
      completedAt: now,
      updatedAt: now,
    };
    await agentRuns.save(record);
    throw error;
  } finally {
    await runtime.close();
    await computer?.destroy();
  }
}
