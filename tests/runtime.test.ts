import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '../src/events.js';
import { createToolExecutionId, type ToolExecutionLedger, type ToolExecutionRecord } from '../src/execution-ledger.js';
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


test('runtime reuses a completed durable tool execution after resume', async (t) => {
  const checkpoint: RunCheckpoint = {
    runId: 'run-reuse',
    status: 'running',
    prompt: 'continue',
    step: 0,
    messages: [{ role: 'user', content: 'continue' }],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
  const checkpoints = new Map<string, RunCheckpoint>([['run-reuse', structuredClone(checkpoint)]]);
  const store: RunStore = {
    async save(next) { checkpoints.set(next.runId, structuredClone(next)); },
    async load(runId) {
      const next = checkpoints.get(runId);
      return next ? structuredClone(next) : undefined;
    },
  };

  const priorCall = { id: 'old-provider-id', name: 'add', arguments: { a: 1, b: 2 } };
  const executionId = createToolExecutionId('run-reuse', 1, 0, priorCall);
  const records = new Map<string, ToolExecutionRecord>([[
    executionId,
    {
      executionId,
      runId: 'run-reuse',
      step: 1,
      toolIndex: 0,
      toolCall: priorCall,
      idempotency: 'idempotent',
      status: 'completed',
      result: '{"ok":true,"result":3}',
      isError: false,
      startedAt: '2026-09-30T00:00:01.000Z',
      completedAt: '2026-09-30T00:00:02.000Z',
      updatedAt: '2026-09-30T00:00:02.000Z',
    },
  ]]);
  const ledger: ToolExecutionLedger = {
    async load(_runId, id) {
      const record = records.get(id);
      return record ? structuredClone(record) : undefined;
    },
    async save(record) { records.set(record.executionId, structuredClone(record)); },
  };

  let calls = 0;
  const provider: Provider = {
    async generate(messages) {
      calls += 1;
      if (calls === 1) {
        return {
          toolCalls: [{ id: 'new-provider-id', name: 'add', arguments: { b: 2, a: 1 } }],
          id: 'response-1',
          model: 'fake',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      assert.ok(messages.some((message) => message.role === 'tool' && message.content.includes('"result":3')));
      return {
        text: 'done',
        id: 'response-2',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    runStore: store,
    executionLedger: ledger,
    skillDirectories: [],
  });
  t.after(() => runtime.close());

  const events: AgentEvent[] = [];
  const result = await runtime.resume('run-reuse', { onEvent: (event) => { events.push(event); } });

  assert.equal(result.text, 'done');
  assert.equal(result.steps, 2);
  assert.ok(events.some((event) => event.type === 'tool_reused' && event.executionId === executionId));
  assert.equal(events.some((event) => event.type === 'tool_start' && event.step === 1), false);
  assert.equal(records.size, 1);
});

test('runtime fails closed on uncertain non-idempotent tool execution', async (t) => {
  const checkpoint: RunCheckpoint = {
    runId: 'run-uncertain',
    status: 'running',
    prompt: 'continue',
    step: 0,
    messages: [{ role: 'user', content: 'continue' }],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
  const checkpoints = new Map<string, RunCheckpoint>([['run-uncertain', structuredClone(checkpoint)]]);
  const store: RunStore = {
    async save(next) { checkpoints.set(next.runId, structuredClone(next)); },
    async load(runId) {
      const next = checkpoints.get(runId);
      return next ? structuredClone(next) : undefined;
    },
  };

  const priorCall = {
    id: 'old-provider-id',
    name: 'set_plan',
    arguments: { goal: 'Do work', steps: ['One'] },
  };
  const executionId = createToolExecutionId('run-uncertain', 1, 0, priorCall);
  const record: ToolExecutionRecord = {
    executionId,
    runId: 'run-uncertain',
    step: 1,
    toolIndex: 0,
    toolCall: priorCall,
    idempotency: 'unknown',
    status: 'started',
    startedAt: '2026-09-30T00:00:01.000Z',
    updatedAt: '2026-09-30T00:00:01.000Z',
  };
  const ledger: ToolExecutionLedger = {
    async load(_runId, id) {
      return id === executionId ? structuredClone(record) : undefined;
    },
    async save() {
      throw new Error('uncertain execution must not be overwritten');
    },
  };

  const provider: Provider = {
    async generate() {
      return {
        toolCalls: [{
          id: 'new-provider-id',
          name: 'set_plan',
          arguments: { steps: ['One'], goal: 'Do work' },
        }],
        id: 'response-1',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    runStore: store,
    executionLedger: ledger,
    skillDirectories: [],
  });
  t.after(() => runtime.close());

  const events: AgentEvent[] = [];
  await assert.rejects(
    runtime.resume('run-uncertain', { onEvent: (event) => { events.push(event); } }),
    /Tool execution status is uncertain/,
  );

  assert.ok(events.some((event) => event.type === 'tool_execution_uncertain' && event.executionId === executionId));
  assert.equal(events.some((event) => event.type === 'tool_start'), false);
  assert.equal(checkpoints.get('run-uncertain')?.status, 'failed');
});


test('runtime safely replays a started idempotent tool execution', async (t) => {
  const checkpoint: RunCheckpoint = {
    runId: 'run-idempotent',
    status: 'running',
    prompt: 'continue',
    step: 0,
    messages: [{ role: 'user', content: 'continue' }],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
  const checkpoints = new Map<string, RunCheckpoint>([['run-idempotent', structuredClone(checkpoint)]]);
  const store: RunStore = {
    async save(next) { checkpoints.set(next.runId, structuredClone(next)); },
    async load(runId) {
      const next = checkpoints.get(runId);
      return next ? structuredClone(next) : undefined;
    },
  };

  const priorCall = { id: 'old-provider-id', name: 'add', arguments: { a: 2, b: 3 } };
  const executionId = createToolExecutionId('run-idempotent', 1, 0, priorCall);
  const records = new Map<string, ToolExecutionRecord>([[
    executionId,
    {
      executionId,
      runId: 'run-idempotent',
      step: 1,
      toolIndex: 0,
      toolCall: priorCall,
      idempotency: 'idempotent',
      status: 'started',
      startedAt: '2026-09-30T00:00:01.000Z',
      updatedAt: '2026-09-30T00:00:01.000Z',
    },
  ]]);
  const ledger: ToolExecutionLedger = {
    async load(_runId, id) {
      const record = records.get(id);
      return record ? structuredClone(record) : undefined;
    },
    async save(record) { records.set(record.executionId, structuredClone(record)); },
  };

  let calls = 0;
  const provider: Provider = {
    async generate(messages) {
      calls += 1;
      if (calls === 1) {
        return {
          toolCalls: [{ id: 'new-provider-id', name: 'add', arguments: { b: 3, a: 2 } }],
          id: 'response-1',
          model: 'fake',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      assert.ok(messages.some((message) => message.role === 'tool' && message.content.includes('"result":5')));
      return {
        text: 'done',
        id: 'response-2',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    runStore: store,
    executionLedger: ledger,
    skillDirectories: [],
  });
  t.after(() => runtime.close());

  const events: AgentEvent[] = [];
  await runtime.resume('run-idempotent', { onEvent: (event) => { events.push(event); } });

  assert.ok(events.some((event) => event.type === 'tool_start' && event.step === 1));
  assert.equal(events.some((event) => event.type === 'tool_execution_uncertain'), false);
  assert.equal(records.get(executionId)?.status, 'completed');
  assert.equal(records.get(executionId)?.result, '{"ok":true,"result":5}');
});


test('failed runs roll back conversation, task, and skill session state', async (t) => {
  const stable = {
    messages: [
      { role: 'user' as const, content: 'stable question' },
      { role: 'assistant' as const, content: 'stable answer' },
    ],
    task: {
      goal: 'Stable plan',
      steps: [{ description: 'Keep this', status: 'in_progress' as const }],
    },
    skills: [],
  };

  let calls = 0;
  const provider: Provider = {
    async generate() {
      calls += 1;
      if (calls === 1) {
        return {
          toolCalls: [{
            id: 'plan-1',
            name: 'set_plan',
            arguments: { goal: 'Failed plan', steps: ['Should roll back'] },
          }],
          id: 'response-1',
          model: 'fake',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      throw new Error('provider failed');
    },
  };

  const runStore: RunStore = {
    async save() {},
    async load() { return undefined; },
  };
  const records = new Map<string, ToolExecutionRecord>();
  const executionLedger: ToolExecutionLedger = {
    async load(_runId, executionId) {
      const record = records.get(executionId);
      return record ? structuredClone(record) : undefined;
    },
    async save(record) {
      records.set(record.executionId, structuredClone(record));
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    runStore,
    executionLedger,
    skillDirectories: [],
  });
  t.after(() => runtime.close());
  await runtime.restoreSession(stable);

  await assert.rejects(runtime.run('this run should fail'), /provider failed/);
  assert.deepEqual(runtime.getSessionState(), stable);
  assert.deepEqual(runtime.getTaskState(), stable.task);
});

test('runtime default step budget supports tool-heavy runs beyond eight turns', async (t) => {
  let calls = 0;
  const provider: Provider = {
    async generate(messages) {
      calls += 1;
      if (calls <= 9) {
        return {
          toolCalls: [{
            id: `add-${calls}`,
            name: 'add',
            arguments: { a: calls, b: 1 },
          }],
          id: `response-${calls}`,
          model: 'fake',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      assert.ok(messages.some((message) => message.role === 'tool'));
      return {
        text: 'done after many tools',
        id: 'response-final',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    runStore: {
      async save() {},
      async load() { return undefined; },
    },
    executionLedger: {
      async load() { return undefined; },
      async save() {},
    },
    skillDirectories: [],
  });
  t.after(() => runtime.close());

  const result = await runtime.run('use several tools');
  assert.equal(result.text, 'done after many tools');
  assert.equal(result.steps, 10);
  assert.equal(calls, 10);
});

test('runtime still enforces an explicit max step budget', async (t) => {
  let calls = 0;
  const provider: Provider = {
    async generate() {
      calls += 1;
      return {
        toolCalls: [{
          id: `add-${calls}`,
          name: 'add',
          arguments: { a: 1, b: 1 },
        }],
        id: `response-${calls}`,
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    maxSteps: 3,
    runStore: {
      async save() {},
      async load() { return undefined; },
    },
    executionLedger: {
      async load() { return undefined; },
      async save() {},
    },
    skillDirectories: [],
  });
  t.after(() => runtime.close());

  await assert.rejects(runtime.run('loop forever'), /Agent run exceeded max steps: 3/);
  assert.equal(calls, 3);
});

test('runtime executes injected computer tools and feeds results back to the model', async (t) => {
  const computerCalls: unknown[] = [];
  const computer: import('../src/computer.js').Computer = {
    ref: { backend: 'fake', id: 'computer-1', workspaceId: 'workspace-1' },
    capabilities: {
      persistentFilesystem: true,
      persistentMemory: false,
      pauseResume: false,
      snapshot: false,
      fork: false,
      desktop: false,
    },
    async exec(input) {
      computerCalls.push(input);
      return { exitCode: 0, stdout: '/workspace\n', stderr: '' };
    },
    async readTextFile() { return ''; },
    async writeTextFile() {},
    async suspend() {},
    async resume() {},
    async snapshot() { throw new Error('unsupported'); },
    async destroy() {},
  };

  let calls = 0;
  const provider: Provider = {
    async generate(messages, tools) {
      calls += 1;
      assert.ok(tools.some((tool) => tool.name === 'computer_exec'));
      if (calls === 1) {
        return {
          toolCalls: [{
            id: 'computer-1',
            name: 'computer_exec',
            arguments: { command: 'pwd' },
          }],
          id: 'response-1',
          model: 'fake',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      assert.ok(messages.some((message) =>
        message.role === 'tool' &&
        message.toolCallId === 'computer-1' &&
        message.content.includes('/workspace'),
      ));
      return {
        text: 'computer worked',
        id: 'response-2',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    computer,
    runStore: {
      async save() {},
      async load() { return undefined; },
    },
    executionLedger: {
      async load() { return undefined; },
      async save() {},
    },
    skillDirectories: [],
  });
  t.after(() => runtime.close());

  const result = await runtime.run('show the current directory');
  assert.equal(result.text, 'computer worked');
  assert.equal(result.steps, 2);
  assert.deepEqual(computerCalls, [{ command: 'pwd' }]);
});

test('runtime tells the model that E2B is the active computer backend', async (t) => {
  const computer: import('../src/computer.js').Computer = {
    ref: { backend: 'e2b', id: 'sandbox-1', workspaceId: 'workspace-1' },
    capabilities: {
      persistentFilesystem: true,
      persistentMemory: true,
      pauseResume: true,
      snapshot: false,
      fork: false,
      desktop: false,
    },
    async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
    async readTextFile() { return ''; },
    async writeTextFile() {},
    async suspend() {},
    async resume() {},
    async snapshot() { throw new Error('unsupported'); },
    async destroy() {},
  };

  let seenMessages: Message[] = [];
  let seenTools: import('../src/tools.js').ToolDefinition[] = [];
  const provider: Provider = {
    async generate(messages, tools = []) {
      seenMessages = structuredClone(messages);
      seenTools = structuredClone(tools);
      return {
        text: 'ready',
        id: 'response-1',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    computer,
    runStore: {
      async save() {},
      async load() { return undefined; },
    },
    executionLedger: {
      async load() { return undefined; },
      async save() {},
    },
    skillDirectories: [],
  });
  t.after(() => runtime.close());

  await runtime.run('run ls in E2B');
  const system = seenMessages.find((message) => message.role === 'system');
  assert.ok(system && 'content' in system);
  assert.ok(system.content.includes('Current computer: e2b backend'));
  assert.ok(system.content.includes('E2B is a computer backend, not a skill.'));
  assert.ok(
    seenTools.find((tool) => tool.name === 'computer_exec')?.description.includes('E2B sandbox'),
  );
});

