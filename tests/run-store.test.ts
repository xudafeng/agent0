import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileRunStore, type RunCheckpoint } from '../src/run-store.js';

const checkpoint = (overrides: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
  runId: 'run-1',
  status: 'running',
  prompt: 'test',
  step: 0,
  messages: [{ role: 'user', content: 'test' }],
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
  ...overrides,
});

test('file run store saves, loads, and overwrites checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-runs-'));
  const store = createFileRunStore(root);

  assert.equal(await store.load('missing'), undefined);

  await store.save(checkpoint());
  assert.deepEqual(await store.load('run-1'), checkpoint());

  const completed = checkpoint({
    status: 'completed',
    step: 2,
    result: 'done',
    updatedAt: '2026-09-24T00:00:02.000Z',
  });
  await store.save(completed);

  assert.deepEqual(await store.load('run-1'), completed);
  const raw = JSON.parse(await readFile(join(root, 'run-1.json'), 'utf8'));
  assert.equal(raw.status, 'completed');
  assert.equal(raw.result, 'done');
});


test('file run store rejects invalid run IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-runs-'));
  const store = createFileRunStore(root);

  await assert.rejects(store.load('../escape'), /Invalid run ID/);
});
