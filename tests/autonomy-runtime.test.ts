import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileArtifactStore } from '../src/artifact.js';
import { createFileMissionStore } from '../src/autonomy.js';
import { createFileMemoryStore } from '../src/memory.js';
import { createFilePersonalStateStore } from '../src/personal-state.js';
import type { Message, Provider } from '../src/provider.js';
import { createAgentRuntime } from '../src/runtime.js';

test('runtime injects the latest active mission into every model turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-autonomy-runtime-'));
  const missions = createFileMissionStore(join(root, 'autonomy'));
  await missions.create('Launch autonomous runtime', [
    { title: 'Implement mission graph' },
    { title: 'Validate it', dependsOn: [0] },
  ]);

  let seen: Message[] = [];
  const provider: Provider = {
    async generate(messages) {
      seen = structuredClone(messages);
      return {
        text: 'continue',
        id: 'response',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    missionStore: missions,
    artifactStore: createFileArtifactStore(join(root, 'artifacts')),
    memoryStore: createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md')),
    personalStateStore: createFilePersonalStateStore(join(root, 'personal')),
    skillDirectories: [],
    runStore: { async save() {}, async load() { return undefined; } },
    executionLedger: { async load() { return undefined; }, async save() {} },
  });
  t.after(() => runtime.close());

  await runtime.run('continue the work');

  const system = seen.find((message) => message.role === 'system');
  assert.ok(system && 'content' in system);
  if (!system || !('content' in system)) return;
  assert.ok(system.content.includes('Current autonomous mission:'));
  assert.ok(system.content.includes('Launch autonomous runtime'));
  assert.ok(system.content.includes('Implement mission graph'));
});
