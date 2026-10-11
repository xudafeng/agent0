import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileArtifactStore } from '../src/artifact.js';

test('artifact store creates lists and reads durable artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-artifacts-'));
  const store = createFileArtifactStore(root);

  const artifact = await store.create({
    title: 'Research report',
    kind: 'markdown',
    content: '# Findings\n\nUseful result.',
  });

  const listed = await store.list();
  assert.equal(listed[0]?.id, artifact.id);
  assert.equal(listed[0]?.title, 'Research report');

  const loaded = await store.read(artifact.id);
  assert.equal(loaded.artifact.id, artifact.id);
  assert.ok(loaded.content.includes('Useful result.'));
});
