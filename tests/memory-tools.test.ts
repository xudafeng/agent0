import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileMemoryStore } from '../src/memory.js';
import { createMemoryTools } from '../src/memory-tools.js';
import { createToolRegistry } from '../src/tools.js';

test('memory tools expose durable CRUD and search operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-memory-tools-'));
  const store = createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md'));
  let changes = 0;
  const registry = createToolRegistry(createMemoryTools(store, () => { changes += 1; }));

  const remembered = await registry.execute({
    id: 'remember-1',
    name: 'memory_remember',
    arguments: { content: 'Uses E2B for cloud execution', scope: 'projects' },
  }) as { id: string };

  assert.ok(remembered.id);
  assert.equal(changes, 1);

  const found = await registry.execute({
    id: 'search-1',
    name: 'memory_search',
    arguments: { query: 'E2B cloud', scope: 'projects' },
  }) as Array<{ id: string }>;
  assert.equal(found[0]?.id, remembered.id);

  await registry.execute({
    id: 'update-1',
    name: 'memory_update',
    arguments: { id: remembered.id, content: 'Uses E2B for durable cloud execution', scope: 'working' },
  });
  assert.equal(changes, 2);
  assert.equal((await store.list('working'))[0]?.id, remembered.id);

  await registry.execute({
    id: 'forget-1',
    name: 'memory_forget',
    arguments: { id: remembered.id },
  });
  assert.equal(changes, 3);
  assert.deepEqual(await store.list(), []);
});
