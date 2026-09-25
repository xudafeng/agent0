import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '../src/events.js';
import type { Message, Provider } from '../src/provider.js';
import type { RunCheckpoint, RunStore } from '../src/run-store.js';
import { createAgentRuntime } from '../src/runtime.js';

test('runtime resumes a running checkpoint from the next safe turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillRoot = join(root, 'skills');
  await mkdir(join(skillRoot, 'review'), { recursive: true });
  await writeFile(
    join(skillRoot, 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review code changes.\n---\nRestored skill instructions.\n',
  );

  const initial: RunCheckpoint = {
    runId: 'run-1',
    status: 'running',
    prompt: 'continue the task',
    step: 1,
    messages: [
      { role: 'user', content: 'continue the task' },
      {
        role: 'assistant',
        toolCalls: [{ id: 'add-1', name: 'add', arguments: { a: 1, b: 2 } }],
      },
      { role: 'tool', toolCallId: 'add-1', content: '{"ok":true,"result":3}' },
    ],
    task: {
      goal: 'Resume safely',
      steps: [
        { description: 'Finish first turn', status: 'completed' },
        { description: 'Continue after restart', status: 'in_progress' },
      ],
    },
    skills: ['review'],
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:01.000Z',
  };

  const checkpoints = new Map<string, RunCheckpoint>([['run-1', structuredClone(initial)]]);
  const store: RunStore = {
    async save(checkpoint) {
      checkpoints.set(checkpoint.runId, structuredClone(checkpoint));
    },
    async load(runId) {
      const checkpoint = checkpoints.get(runId);
      return checkpoint ? structuredClone(checkpoint) : undefined;
    },
  };

  let seen: Message[] | undefined;
  const provider: Provider = {
    async generate(messages) {
      seen = structuredClone(messages);
      return {
        text: 'resumed successfully',
        id: 'response-1',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    runStore: store,
    skillDirectories: [skillRoot],
  });
  t.after(() => runtime.close());

  const events: AgentEvent[] = [];
  const result = await runtime.resume('run-1', {
    onEvent: (event) => { events.push(event); },
  });

  assert.deepEqual(result, {
    runId: 'run-1',
    text: 'resumed successfully',
    steps: 2,
  });
  assert.equal(events[0]?.type, 'run_resumed');
  assert.equal(events[0]?.type === 'run_resumed' ? events[0].fromStep : undefined, 1);
  assert.ok(events.some((event) => event.type === 'turn_start' && event.step === 2));

  assert.ok(seen);
  const system = seen.find((message) => message.role === 'system');
  assert.ok(system && 'content' in system);
  assert.ok(system.content.includes('Resume safely'));
  assert.ok(system.content.includes('Restored skill instructions.'));
  assert.ok(seen.some((message) => message.role === 'tool' && message.toolCallId === 'add-1'));

  assert.deepEqual(runtime.getTaskState(), initial.task);
  assert.deepEqual(runtime.getSkills().loaded, ['review']);

  const completed = checkpoints.get('run-1');
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.step, 2);
  assert.equal(completed?.result, 'resumed successfully');
  assert.equal(completed?.createdAt, initial.createdAt);
  assert.deepEqual(completed?.skills, ['review']);

  await assert.rejects(runtime.resume('run-1'), /Run is not resumable: completed/);
  await assert.rejects(runtime.resume('missing'), /Run not found: missing/);
});
