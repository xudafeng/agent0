import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileArtifactStore } from '../src/artifact.js';
import { createFileMissionStore } from '../src/autonomy.js';
import type { ExaClient } from '../src/exa.js';
import { createFileMemoryStore } from '../src/memory.js';
import { createFilePersonalStateStore } from '../src/personal-state.js';
import type { Provider } from '../src/provider.js';
import { createAgentRuntime } from '../src/runtime.js';

test('runtime exposes native Exa web tools when configured', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-web-runtime-'));
  const exa: ExaClient = {
    async search() { return { results: [] }; },
    async fetch(input) { return { title: 'Page', url: input.url, highlights: [] }; },
  };

  let seenTools: string[] = [];
  const provider: Provider = {
    async generate(_messages, tools = []) {
      seenTools = tools.map((tool) => tool.name);
      return {
        text: 'done',
        id: 'response',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    exaClient: exa,
    memoryStore: createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md')),
    personalStateStore: createFilePersonalStateStore(join(root, 'personal')),
    missionStore: createFileMissionStore(join(root, 'autonomy')),
    artifactStore: createFileArtifactStore(join(root, 'artifacts')),
    skillDirectories: [],
    runStore: { async save() {}, async load() { return undefined; } },
    executionLedger: { async load() { return undefined; }, async save() {} },
  });
  t.after(() => runtime.close());

  await runtime.run('search the web');

  assert.ok(seenTools.includes('web_search'));
  assert.ok(seenTools.includes('web_fetch'));
});

test('runtime can explicitly disable Exa web tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-web-runtime-'));
  let seenTools: string[] = [];
  const provider: Provider = {
    async generate(_messages, tools = []) {
      seenTools = tools.map((tool) => tool.name);
      return {
        text: 'done',
        id: 'response',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const runtime = await createAgentRuntime({
    provider,
    exaClient: null,
    memoryStore: createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md')),
    personalStateStore: createFilePersonalStateStore(join(root, 'personal')),
    missionStore: createFileMissionStore(join(root, 'autonomy')),
    artifactStore: createFileArtifactStore(join(root, 'artifacts')),
    skillDirectories: [],
    runStore: { async save() {}, async load() { return undefined; } },
    executionLedger: { async load() { return undefined; }, async save() {} },
  });
  t.after(() => runtime.close());

  await runtime.run('do not search');

  assert.equal(seenTools.includes('web_search'), false);
  assert.equal(seenTools.includes('web_fetch'), false);
});
