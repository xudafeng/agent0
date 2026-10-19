import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileAgentAutomationStore } from '../src/agent-automation.js';
import { runAgentAutomationWake } from '../src/agent-automation-runtime.js';
import { createFileAgentRunStore, type AgentRunRecord } from '../src/agent-run-store.js';
import type { HeadlessAgentRunOptions, HeadlessAgentRunResult } from '../src/agent-run.js';

function runningRecord(
  id: string,
  options: HeadlessAgentRunOptions,
  now = '2026-10-10T13:00:00.000Z',
): AgentRunRecord {
  return {
    version: 1,
    agentRunId: id,
    trigger: 'scheduled',
    status: 'running',
    prompt: options.prompt ?? '',
    sessionId: 'session-test',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.skillName === undefined ? {} : { skillName: options.skillName }),
    skillRoots: [...(options.skillRoots ?? [])],
    policy: options.policy ?? 'read-only',
    createdAt: now,
    updatedAt: now,
  };
}

test('wake catches up one missed interval and advances from wake time', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const store = createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const automation = await store.create({
    name: 'radar',
    prompt: 'Run radar.',
    cwd: '/tmp/radar',
    skillName: 'radar',
    skillRoots: ['/tmp/radar'],
    policy: 'trusted-workspace',
    repeatEveryMs: 12 * 60 * 60 * 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  let calls = 0;
  const execute = async (options: HeadlessAgentRunOptions): Promise<HeadlessAgentRunResult> => {
    calls += 1;
    const running = runningRecord('agent-run-1', options);
    await options.onAgentRunCreated?.(running);
    const completed: AgentRunRecord = {
      ...running,
      status: 'completed',
      runtimeRunId: 'runtime-1',
      result: 'done',
      completedAt: '2026-10-10T13:05:00.000Z',
      updatedAt: '2026-10-10T13:05:00.000Z',
    };
    return { record: completed, text: 'done', steps: 3 };
  };

  const wake = await runAgentAutomationWake(
    profile,
    new Date('2026-10-10T13:00:00.000Z'),
    { store, execute },
  );

  assert.equal(calls, 1);
  assert.equal(wake.automations[0]?.status, 'completed');
  assert.equal(wake.automations[0]?.agentRunId, 'agent-run-1');

  const updated = await store.get(automation.automationId);
  assert.equal(updated.runCount, 1);
  assert.equal(updated.lastAgentRunId, 'agent-run-1');
  assert.equal(updated.runningAgentRunId, undefined);
  assert.equal(updated.nextRunAt, '2026-10-11T01:00:00.000Z');
  assert.equal(updated.lastError, undefined);

  const second = await runAgentAutomationWake(
    profile,
    new Date('2026-10-10T13:01:00.000Z'),
    { store, execute },
  );
  assert.equal(second.automations.length, 0);
  assert.equal(calls, 1);
});

test('failed scheduled AgentRun records the error and waits for the next interval', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const store = createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const automation = await store.create({
    prompt: 'Run radar.',
    cwd: '/tmp/radar',
    repeatEveryMs: 60 * 60 * 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const execute = async (options: HeadlessAgentRunOptions): Promise<HeadlessAgentRunResult> => {
    await options.onAgentRunCreated?.(runningRecord('agent-run-failed', options, '2026-10-10T02:00:00.000Z'));
    throw new Error('network unavailable');
  };

  const wake = await runAgentAutomationWake(
    profile,
    new Date('2026-10-10T02:00:00.000Z'),
    { store, execute },
  );

  assert.equal(wake.automations[0]?.status, 'failed');
  assert.match(wake.automations[0]?.error ?? '', /network unavailable/);

  const updated = await store.get(automation.automationId);
  assert.equal(updated.runCount, 1);
  assert.equal(updated.runningAgentRunId, undefined);
  assert.equal(updated.nextRunAt, '2026-10-10T03:00:00.000Z');
  assert.match(updated.lastError ?? '', /network unavailable/);
});

test('wake skips a due automation claimed by another worker', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const store = createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const automation = await store.create({
    prompt: 'Run.',
    cwd: '/tmp/project',
    repeatEveryMs: 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const release = await store.claim(automation.automationId);
  assert.ok(release);

  let called = false;
  const wake = await runAgentAutomationWake(
    profile,
    new Date('2026-10-10T00:00:02.000Z'),
    {
      store,
      execute: async () => {
        called = true;
        throw new Error('must not run');
      },
    },
  );

  assert.equal(called, false);
  assert.equal(wake.automations[0]?.status, 'skipped');
  assert.match(wake.automations[0]?.reason ?? '', /already claimed/);
  await release!();
});

test('wake skips when a previous AgentRun is still marked running', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const store = createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const automation = await store.create({
    prompt: 'Run.',
    cwd: '/tmp/project',
    repeatEveryMs: 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const agentRuns = createFileAgentRunStore(join(profile, 'data', 'agent-runs'));
  const running = await agentRuns.create({
    trigger: 'scheduled',
    status: 'running',
    prompt: 'Run.',
    sessionId: 'session-existing',
    cwd: '/tmp/project',
    skillRoots: [],
    policy: 'trusted-workspace',
  });

  const changed = await store.get(automation.automationId);
  changed.runningAgentRunId = running.agentRunId;
  changed.lastAgentRunId = running.agentRunId;
  await store.save(changed);

  let called = false;
  const wake = await runAgentAutomationWake(
    profile,
    new Date('2026-10-10T00:00:02.000Z'),
    {
      store,
      execute: async () => {
        called = true;
        throw new Error('must not run');
      },
    },
  );

  assert.equal(called, false);
  assert.equal(wake.automations[0]?.status, 'skipped');
  assert.equal(wake.automations[0]?.agentRunId, running.agentRunId);
  assert.match(wake.automations[0]?.reason ?? '', /still running/);
});


test('wake resumes a stale running AgentRun before the next scheduled period', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const store = createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const automation = await store.create({
    prompt: 'Run radar.',
    cwd: '/tmp/radar',
    repeatEveryMs: 12 * 60 * 60 * 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const agentRuns = createFileAgentRunStore(join(profile, 'data', 'agent-runs'));
  const running = await agentRuns.create({
    trigger: 'scheduled',
    status: 'running',
    prompt: 'Run radar.',
    sessionId: 'session-stale',
    cwd: '/tmp/radar',
    skillRoots: [],
    policy: 'trusted-workspace',
    runtimeRunId: 'runtime-stale',
    ownerPid: 2147483647,
    heartbeatAt: '2026-10-10T00:05:00.000Z',
  });

  const changed = await store.get(automation.automationId);
  changed.runningAgentRunId = running.agentRunId;
  changed.lastAgentRunId = running.agentRunId;
  changed.runCount = 1;
  await store.save(changed);

  let resumeId: string | undefined;
  const wake = await runAgentAutomationWake(
    profile,
    new Date('2026-10-10T01:00:00.000Z'),
    {
      store,
      execute: async (options) => {
        resumeId = options.resumeAgentRunId;
        return {
          record: {
            ...running,
            status: 'completed',
            result: 'resumed',
            completedAt: '2026-10-10T01:01:00.000Z',
            updatedAt: '2026-10-10T01:01:00.000Z',
          },
          text: 'resumed',
          steps: 2,
        };
      },
    },
  );

  assert.equal(resumeId, running.agentRunId);
  assert.equal(wake.automations[0]?.status, 'completed');
  const updated = await store.get(automation.automationId);
  assert.equal(updated.runningAgentRunId, undefined);
  assert.equal(updated.runCount, 1);
});

test('wake does not resume a running AgentRun whose owner process is alive', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const store = createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const automation = await store.create({
    prompt: 'Run.',
    cwd: '/tmp/project',
    repeatEveryMs: 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const agentRuns = createFileAgentRunStore(join(profile, 'data', 'agent-runs'));
  const running = await agentRuns.create({
    trigger: 'scheduled',
    status: 'running',
    prompt: 'Run.',
    sessionId: 'session-live',
    cwd: '/tmp/project',
    skillRoots: [],
    policy: 'trusted-workspace',
    runtimeRunId: 'runtime-live',
    ownerPid: process.pid,
    heartbeatAt: new Date().toISOString(),
  });

  const changed = await store.get(automation.automationId);
  changed.runningAgentRunId = running.agentRunId;
  changed.lastAgentRunId = running.agentRunId;
  await store.save(changed);

  let called = false;
  const wake = await runAgentAutomationWake(
    profile,
    new Date('2026-10-10T00:00:02.000Z'),
    {
      store,
      execute: async () => {
        called = true;
        throw new Error('must not execute');
      },
    },
  );

  assert.equal(called, false);
  assert.match(wake.automations[0]?.reason ?? '', /still running/);
});

test('automation timeout aborts the run and applies failure backoff', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const store = createFileAgentAutomationStore(join(profile, 'data', 'agent-automations'));
  const automation = await store.create({
    prompt: 'Run.',
    cwd: '/tmp/project',
    repeatEveryMs: 1000,
    maxRunMs: 20,
    now: new Date(Date.now() - 10_000),
  });

  const wake = await runAgentAutomationWake(profile, new Date(), {
    store,
    execute: async (options) => {
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    },
  });

  assert.equal(wake.automations[0]?.status, 'failed');
  assert.match(wake.automations[0]?.error ?? '', /timed out/);

  const updated = await store.get(automation.automationId);
  assert.equal(updated.consecutiveFailures, 1);
  assert.ok(updated.backoffUntil);
  assert.ok(new Date(updated.nextRunAt).getTime() >= new Date(updated.backoffUntil!).getTime());
});
