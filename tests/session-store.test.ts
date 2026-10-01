import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileSessionStore, type SessionSnapshot } from '../src/session-store.js';

test('file session store saves, loads, and clears the latest completed session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'session.json');
  const store = createFileSessionStore(path);
  const snapshot: SessionSnapshot = {
    version: 1,
    history: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', steps: 1 },
    ],
    runtime: {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      task: {
        goal: 'Keep context',
        steps: [{ description: 'Continue tomorrow', status: 'in_progress' }],
      },
      skills: ['review'],
    },
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  assert.equal(await store.load(), undefined);
  await store.save(snapshot);
  assert.deepEqual(await store.load(), snapshot);

  await store.clear();
  assert.equal(await store.load(), undefined);
  await assert.rejects(access(path));
});
