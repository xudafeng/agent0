import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileAgentAutomationStore } from '../src/agent-automation.js';
import { createAgentAutomationTools } from '../src/agent-automation-tools.js';
import { createToolRegistry } from '../src/tools.js';

test('schedule_agent_run creates a durable 12-hour automation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-automation-tools-'));
  const store = createFileAgentAutomationStore(root);
  const registry = createToolRegistry(createAgentAutomationTools(store));

  const automation = await registry.execute({
    id: 'schedule-agent',
    name: 'schedule_agent_run',
    arguments: {
      name: 'radar',
      prompt: 'Run radar.',
      cwd: '/tmp/radar',
      skillName: 'radar',
      skillRoots: ['/tmp/radar'],
      policy: 'trusted-workspace',
      repeatEveryMs: 43_200_000,
    },
  }) as { name: string; repeatEveryMs: number };

  assert.equal(automation.name, 'radar');
  assert.equal(automation.repeatEveryMs, 43_200_000);
  assert.equal((await store.list()).length, 1);
});

test('schedule_agent_run rejects ambiguous recurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-automation-tools-'));
  const store = createFileAgentAutomationStore(root);
  const registry = createToolRegistry(createAgentAutomationTools(store));

  await assert.rejects(
    registry.execute({
      id: 'bad-schedule',
      name: 'schedule_agent_run',
      arguments: {
        prompt: 'Run.',
        cwd: '/tmp/project',
        repeatEveryMs: 1000,
        cronExpression: '* * * * *',
        timeZone: 'UTC',
      },
    }),
    /exactly one recurrence/,
  );
});
