import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileMemoryStore } from '../src/memory.js';
import { createFilePersonalStateStore } from '../src/personal-state.js';
import type { Message, Provider } from '../src/provider.js';
import { createAgentRuntime } from '../src/runtime.js';

test('runtime injects persistent personal state into every model turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-personal-runtime-'));
  const personal = createFilePersonalStateStore(join(root, 'personal'));
  await personal.setDailyFocus('Finish agent0 personal state');
  const goal = await personal.addGoal('Build a daily-use personal agent');
  await personal.addTask('Complete the current PR', goal.id);

  let seen: Message[] = [];
  const provider: Provider = {
    async generate(messages) {
      seen = structuredClone(messages);
      return {
        text: 'done',
        id: 'response-1',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    personalStateStore: personal,
    memoryStore: createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md')),
    skillDirectories: [],
    runStore: { async save() {}, async load() { return undefined; } },
    executionLedger: { async load() { return undefined; }, async save() {} },
  });
  t.after(() => runtime.close());

  await runtime.run('What should I work on next?');

  const system = seen.find((message) => message.role === 'system');
  assert.ok(system && 'content' in system);
  if (!system || !('content' in system)) return;
  assert.ok(system.content.includes('Current personal state:'));
  assert.ok(system.content.includes('Finish agent0 personal state'));
  assert.ok(system.content.includes('Build a daily-use personal agent'));
  assert.ok(system.content.includes('Complete the current PR'));
});
