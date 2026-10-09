import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileMemoryStore } from '../src/memory.js';
import type { Message, Provider } from '../src/provider.js';
import { createAgentRuntime } from '../src/runtime.js';

test('runtime retrieves prompt-relevant memory before building context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-memory-runtime-'));
  const memoryStore = createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md'));
  await memoryStore.remember('Uses E2B for cloud sandbox execution', 'projects');
  await memoryStore.remember('Prefers short meeting notes', 'preferences');

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
    memoryStore,
    skillDirectories: [],
    runStore: {
      async save() {},
      async load() { return undefined; },
    },
    executionLedger: {
      async load() { return undefined; },
      async save() {},
    },
  });
  t.after(() => runtime.close());

  await runtime.run('How should I run code in the E2B cloud sandbox?');

  const system = seen.find((message) => message.role === 'system');
  assert.ok(system && 'content' in system);
  if (!system || !('content' in system)) return;
  assert.ok(system.content.includes('Uses E2B for cloud sandbox execution'));
  assert.ok(!system.content.includes('Prefers short meeting notes'));
});

test('runtime memory mutations refresh the compatibility memory view', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-memory-runtime-'));
  const memoryStore = createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md'));
  const provider: Provider = {
    async generate() {
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
    memoryStore,
    skillDirectories: [],
    runStore: {
      async save() {},
      async load() { return undefined; },
    },
    executionLedger: {
      async load() { return undefined; },
      async save() {},
    },
  });
  t.after(() => runtime.close());

  await runtime.remember('Persistent fact', 'profile');
  const [entry] = await runtime.listMemory('profile');
  assert.ok(entry);
  assert.ok(runtime.getMemory().includes('[profile] Persistent fact'));

  await runtime.updateMemory(entry.id, 'Updated fact', 'profile');
  assert.ok(runtime.getMemory().includes('Updated fact'));

  await runtime.forgetMemory(entry.id);
  assert.ok(!runtime.getMemory().includes('Updated fact'));
});
