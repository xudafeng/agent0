import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry, type AgentTool } from '../src/tools.js';

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
