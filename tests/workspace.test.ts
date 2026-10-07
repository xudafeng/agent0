import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileWorkspaceStore } from '../src/workspace.js';

test('file workspace store creates stable durable workspace identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileWorkspaceStore(root);

  const created = await store.create('workspace-1');
  const loaded = await store.load('workspace-1');

  assert.deepEqual(loaded, created);
  assert.equal(store.directory('workspace-1'), join(root, 'workspace-1'));
  await access(join(root, 'workspace-1', 'workspace.json'));
  await access(join(root, 'workspace-1', 'files'));

  const same = await store.create('workspace-1');
  assert.deepEqual(same, created);
});

test('workspace store rejects path-like workspace IDs', async () => {
  const store = createFileWorkspaceStore('/tmp/agent0-workspaces');

  for (const id of ['../escape', 'a/b', '', '.', '..']) {
    await assert.rejects(store.load(id), /Invalid workspace ID/);
    assert.throws(() => store.directory(id), /Invalid workspace ID/);
  }
});
