import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileAgentRunStore } from '../src/agent-run-store.js';

test('agent run store persists lifecycle metadata and index order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-agent-runs-'));
  const store = createFileAgentRunStore(root);

  const run = await store.create({
    trigger: 'manual',
    status: 'running',
    prompt: 'run radar',
    sessionId: 'session_1',
    cwd: '/tmp/project',
    skillName: 'radar',
    skillRoots: ['/tmp/project'],
    policy: 'trusted-workspace',
  });

  assert.equal((await store.load(run.agentRunId))?.status, 'running');

  const completed = {
    ...run,
    status: 'completed' as const,
    runtimeRunId: 'runtime_1',
    result: 'done',
    completedAt: new Date().toISOString(),
  };
  await store.save(completed);

  const loaded = await store.load(run.agentRunId);
  assert.equal(loaded?.result, 'done');
  assert.equal((await store.list())[0]?.agentRunId, run.agentRunId);
});
