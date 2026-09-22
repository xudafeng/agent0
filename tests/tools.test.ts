import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry, ToolExecutionDeniedError, type AgentTool } from '../src/tools.js';

const tool = (name: string, execute: AgentTool['execute']): AgentTool => ({
  definition: {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute,
});

test('tool registry exposes definitions and executes by name', async () => {
  const registry = createToolRegistry([
    tool('echo', (call) => call.arguments.value),
  ]);

  assert.deepEqual(registry.definitions.map((definition) => definition.name), ['echo']);
  assert.equal(registry.has('echo'), true);
  assert.equal(await registry.execute({ id: '1', name: 'echo', arguments: { value: 'ok' } }), 'ok');
});

test('tool registry rejects duplicate names', () => {
  assert.throws(
    () => createToolRegistry([tool('echo', () => 'a'), tool('echo', () => 'b')]),
    /Duplicate tool: echo/,
  );
});

test('tool registry observes cancellation before execution', async () => {
  let executed = false;
  const registry = createToolRegistry([
    tool('slow', () => {
      executed = true;
      return 'done';
    }),
  ]);
  const controller = new AbortController();
  controller.abort(new Error('stop'));

  await assert.rejects(
    registry.execute({ id: '1', name: 'slow', arguments: {} }, { signal: controller.signal }),
    /stop/,
  );
  assert.equal(executed, false);
});


test('tool registry exposes execution mode with parallel default', () => {
  const registry = createToolRegistry([
    tool('parallel-tool', () => 'ok'),
    {
      ...tool('sequential-tool', () => 'ok'),
      executionMode: 'sequential',
    },
  ]);

  assert.equal(registry.executionMode('parallel-tool'), 'parallel');
  assert.equal(registry.executionMode('sequential-tool'), 'sequential');
  assert.equal(registry.executionMode('missing'), 'parallel');
});


test('tool registry denies execution through policy before calling the tool', async () => {
  let executed = false;
  const registry = createToolRegistry(
    [tool('write', () => {
      executed = true;
      return 'written';
    })],
    (toolCall) => toolCall.name === 'write'
      ? { action: 'deny', reason: 'write requires approval' }
      : { action: 'allow' },
  );

  await assert.rejects(
    registry.execute({ id: '1', name: 'write', arguments: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionDeniedError);
      assert.equal(error.reason, 'write requires approval');
      return true;
    },
  );
  assert.equal(executed, false);
});

test('tool registry supports asynchronous allow policies', async () => {
  const registry = createToolRegistry(
    [tool('read', () => 'content')],
    async () => ({ action: 'allow' }),
  );

  assert.equal(await registry.execute({ id: '1', name: 'read', arguments: {} }), 'content');
});


test('tool registry waits for human approval before execution', async () => {
  const order: string[] = [];
  const registry = createToolRegistry(
    [tool('write', () => {
      order.push('execute');
      return 'written';
    })],
    () => ({ action: 'ask', reason: 'confirm write' }),
  );

  const result = await registry.execute(
    { id: '1', name: 'write', arguments: {} },
    {
      requestApproval: async (request) => {
        order.push(`approve:${request.reason}`);
        return true;
      },
      onExecutionStart: () => { order.push('start'); },
    },
  );

  assert.equal(result, 'written');
  assert.deepEqual(order, ['approve:confirm write', 'start', 'execute']);
});

test('tool registry blocks denied human approval without starting execution', async () => {
  let started = false;
  let executed = false;
  const registry = createToolRegistry(
    [tool('write', () => {
      executed = true;
      return 'written';
    })],
    () => ({ action: 'ask', reason: 'confirm write' }),
  );

  await assert.rejects(
    registry.execute(
      { id: '1', name: 'write', arguments: {} },
      {
        requestApproval: () => false,
        onExecutionStart: () => { started = true; },
      },
    ),
    /Denied by user/,
  );

  assert.equal(started, false);
  assert.equal(executed, false);
});

test('tool registry denies ask decisions when no approval handler is available', async () => {
  const registry = createToolRegistry(
    [tool('write', () => 'written')],
    () => ({ action: 'ask', reason: 'confirm write' }),
  );

  await assert.rejects(
    registry.execute({ id: '1', name: 'write', arguments: {} }),
    /Approval required but no approval handler is available/,
  );
});
