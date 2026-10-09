import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileMemoryStore } from '../src/memory.js';

test('memory store persists scoped markdown entries and supports CRUD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-memory-'));
  const store = createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md'));

  const remembered = await store.remember('Prefers concise answers', 'preferences');
  assert.equal(remembered.scope, 'preferences');

  const duplicate = await store.remember('Prefers concise answers', 'preferences');
  assert.equal(duplicate.id, remembered.id);

  const updated = await store.update(remembered.id, 'Prefers concise, direct answers', 'profile');
  assert.equal(updated.scope, 'profile');

  const profile = await readFile(join(root, 'memory', 'profile.md'), 'utf8');
  assert.ok(profile.includes(remembered.id));
  assert.ok(profile.includes('Prefers concise, direct answers'));

  const entries = await store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.scope, 'profile');

  await store.forget(remembered.id);
  assert.deepEqual(await store.list(), []);
});

test('memory store migrates legacy markdown into general memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-memory-'));
  const legacy = join(root, 'memory.md');
  await writeFile(legacy, '# Memory\n\n- First memory\n- Second memory\n', 'utf8');

  const store = createFileMemoryStore(join(root, 'memory'), legacy);
  const entries = await store.list('general');

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.content), ['First memory', 'Second memory']);
});

test('memory search ranks relevant entries and respects a character budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-memory-'));
  const store = createFileMemoryStore(join(root, 'memory'), join(root, 'legacy.md'));

  await store.remember('Uses E2B for cloud computer execution', 'projects');
  await store.remember('Prefers concise technical explanations', 'preferences');
  await store.remember('Working on durable background scheduling', 'working');

  const results = await store.search('E2B cloud execution', { maxChars: 200, limit: 3 });
  assert.equal(results[0]?.scope, 'projects');
  assert.ok(results[0]?.content.includes('E2B'));

  const tiny = await store.search('', { maxChars: 25, limit: 10 });
  assert.ok(tiny.reduce((sum, entry) => sum + entry.content.length + entry.scope.length + 6, 0) <= 25);
});
