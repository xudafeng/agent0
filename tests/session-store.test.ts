import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileSessionStore, type SessionSnapshot } from '../src/session-store.js';

const snapshot = (user: string, assistant: string): SessionSnapshot => ({
  version: 1,
  history: [
    { role: 'user', content: user },
    { role: 'assistant', content: assistant, steps: 1 },
  ],
  runtime: {
    messages: [
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ],
    skills: [],
  },
  updatedAt: new Date().toISOString(),
});

test('file session store creates, switches, renames, and deletes isolated sessions', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'agent0-sessions-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = createFileSessionStore(join(base, 'sessions'), join(base, 'session.json'));

  assert.deepEqual(await store.list(), []);
  assert.equal(await store.active(), undefined);

  const first = await store.create('Agent learning');
  await store.save(first.id, snapshot('agent question', 'agent answer'));

  const second = await store.create('English');
  await store.save(second.id, snapshot('English question', 'English answer'));

  assert.equal(await store.active(), second.id);
  assert.deepEqual((await store.list()).map((session) => session.id), [second.id, first.id]);
  assert.equal((await store.load(first.id))?.history[0]?.content, 'agent question');
  assert.equal((await store.load(second.id))?.history[0]?.content, 'English question');

  await store.setActive(first.id);
  assert.equal(await store.active(), first.id);

  const renamed = await store.rename(first.id, 'Agent0 study');
  assert.equal(renamed.title, 'Agent0 study');
  assert.equal((await store.list()).find((session) => session.id === first.id)?.title, 'Agent0 study');

  await store.remove(first.id);
  assert.equal(await store.active(), second.id);
  assert.equal(await store.load(first.id), undefined);

  await store.remove(second.id);
  assert.equal(await store.active(), undefined);
  assert.deepEqual(await store.list(), []);

  await assert.rejects(store.load('../escape'), /Invalid session ID/);
});

test('file session store migrates the legacy single session', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'agent0-session-migrate-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const legacyPath = join(base, 'session.json');
  const legacy = snapshot('legacy question', 'legacy answer');
  legacy.updatedAt = '2026-10-01T00:00:00.000Z';
  await writeFile(legacyPath, JSON.stringify(legacy));

  const store = createFileSessionStore(join(base, 'sessions'), legacyPath);
  const sessions = await store.list();

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.title, 'legacy question');
  assert.equal(await store.active(), sessions[0]?.id);
  assert.deepEqual(await store.load(sessions[0]!.id), legacy);
  await assert.rejects(access(legacyPath));
});
