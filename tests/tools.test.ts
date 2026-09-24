import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry, ToolExecutionDeniedError, ToolExecutionTimeoutError, type AgentTool } from '../src/tools.js';

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


test('tool registry enforces opt-in execution timeout', async () => {
  const slow: AgentTool = {
    ...tool('slow', async (_call, context) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        context.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(context.signal!.reason);
        }, { once: true });
      });
      return 'late';
    }),
    timeoutMs: 10,
  };
  const registry = createToolRegistry([slow]);

  await assert.rejects(
    registry.execute({ id: '1', name: 'slow', arguments: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionTimeoutError);
      assert.equal(error.timeoutMs, 10);
      assert.equal(error.toolCall.name, 'slow');
      return true;
    },
  );
});

test('parent cancellation wins over tool timeout', async () => {
  const slow: AgentTool = {
    ...tool('slow', async (_call, context) => {
      await new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(context.signal!.reason), { once: true });
      });
    }),
    timeoutMs: 1000,
  };
  const registry = createToolRegistry([slow]);
  const controller = new AbortController();
  const result = registry.execute(
    { id: '1', name: 'slow', arguments: {} },
    { signal: controller.signal },
  );

  controller.abort(new Error('user stop'));
  await assert.rejects(result, /user stop/);
});


test('retry requires explicit idempotency', () => {
  assert.throws(
    () => createToolRegistry([{
      ...tool('write', () => 'ok'),
      retry: { maxAttempts: 2, shouldRetry: () => true },
    }]),
    /Retry requires idempotent tool: write/,
  );
});

test('idempotent tool retries only retryable failures', async () => {
  let attempts = 0;
  const registry = createToolRegistry([{
    ...tool('read', () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return 'ok';
    }),
    idempotency: 'idempotent',
    retry: {
      maxAttempts: 3,
      shouldRetry: (error) => error instanceof Error && error.message === 'transient',
    },
  }]);

  assert.equal(await registry.execute({ id: '1', name: 'read', arguments: {} }), 'ok');
  assert.equal(attempts, 3);

  attempts = 0;
  const noRetry = createToolRegistry([{
    ...tool('read', () => {
      attempts += 1;
      throw new Error('permanent');
    }),
    idempotency: 'idempotent',
    retry: {
      maxAttempts: 3,
      shouldRetry: (error) => error instanceof Error && error.message === 'transient',
    },
  }]);

  await assert.rejects(noRetry.execute({ id: '2', name: 'read', arguments: {} }), /permanent/);
  assert.equal(attempts, 1);
});

test('parent cancellation interrupts retry delay', async () => {
  let attempts = 0;
  const registry = createToolRegistry([{
    ...tool('read', () => {
      attempts += 1;
      throw new Error('transient');
    }),
    idempotency: 'idempotent',
    retry: {
      maxAttempts: 3,
      delayMs: 1000,
      shouldRetry: () => true,
    },
  }]);
  const controller = new AbortController();
  const result = registry.execute(
    { id: '1', name: 'read', arguments: {} },
    { signal: controller.signal },
  );

  setTimeout(() => controller.abort(new Error('user stop')), 10);
  await assert.rejects(result, /user stop/);
  assert.equal(attempts, 1);
});

test('tool retry configuration is bounded', () => {
  assert.throws(
    () => createToolRegistry([{
      ...tool('read', () => 'ok'),
      idempotency: 'idempotent',
      retry: { maxAttempts: 6, shouldRetry: () => true },
    }]),
    /Invalid retry attempts/,
  );
  assert.throws(
    () => createToolRegistry([{
      ...tool('read', () => 'ok'),
      idempotency: 'idempotent',
      retry: { maxAttempts: 2, delayMs: 30001, shouldRetry: () => true },
    }]),
    /Invalid retry delay/,
  );
});
