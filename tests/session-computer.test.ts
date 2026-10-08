import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Computer, ComputerBackend } from '../src/computer.js';
import { configuredComputerBackend, openSessionComputer } from '../src/session-computer.js';
import { createFileWorkspaceStore } from '../src/workspace.js';

function fakeBackend(name = 'fake') {
  const calls = { create: 0, reconnect: 0 };
  const backend: ComputerBackend = {
    name,
    async create(workspace) {
      calls.create += 1;
      return {
        ref: { backend: name, id: 'computer-created', workspaceId: workspace.id },
        capabilities: {
          persistentFilesystem: true,
          persistentMemory: false,
          pauseResume: false,
          snapshot: false,
          fork: false,
          desktop: false,
        },
        async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
        async readTextFile() { return ''; },
        async writeTextFile() {},
        async suspend() {},
        async resume() {},
        async snapshot() { throw new Error('unsupported'); },
        async destroy() {},
      } satisfies Computer;
    },
    async reconnect(ref) {
      calls.reconnect += 1;
      return {
        ref,
        capabilities: {
          persistentFilesystem: true,
          persistentMemory: false,
          pauseResume: false,
          snapshot: false,
          fork: false,
          desktop: false,
        },
        async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
        async readTextFile() { return ''; },
        async writeTextFile() {},
        async suspend() {},
        async resume() {},
        async snapshot() { throw new Error('unsupported'); },
        async destroy() {},
      } satisfies Computer;
    },
  };
  return { backend, calls };
}

test('session computer creates once and reconnects from the persisted binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-session-computer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = createFileWorkspaceStore(join(root, 'workspaces'));
  const fake = fakeBackend();

  const first = await openSessionComputer(fake.backend, workspaces);
  assert.equal(first.created, true);
  assert.equal(fake.calls.create, 1);
  assert.equal(first.binding.computerRef.id, 'computer-created');
  assert.equal(first.binding.computerRef.workspaceId, first.binding.workspaceId);

  const second = await openSessionComputer(fake.backend, workspaces, first.binding);
  assert.equal(second.created, false);
  assert.equal(fake.calls.create, 1);
  assert.equal(fake.calls.reconnect, 1);
  assert.deepEqual(second.binding, first.binding);
});

test('session computer rejects backend and workspace mismatches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-session-computer-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = createFileWorkspaceStore(join(root, 'workspaces'));
  await workspaces.create('workspace-1');
  const fake = fakeBackend('e2b');

  await assert.rejects(
    openSessionComputer(fake.backend, workspaces, {
      workspaceId: 'workspace-1',
      computerRef: { backend: 'local', id: 'computer-1', workspaceId: 'workspace-1' },
    }),
    /backend mismatch/,
  );

  await assert.rejects(
    openSessionComputer(fake.backend, workspaces, {
      workspaceId: 'workspace-1',
      computerRef: { backend: 'e2b', id: 'computer-1', workspaceId: 'workspace-2' },
    }),
    /workspace mismatch/,
  );
});

test('computer backend configuration requires an E2B API key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-session-computer-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = createFileWorkspaceStore(join(root, 'workspaces'));

  assert.equal(configuredComputerBackend(workspaces, {}), undefined);
  assert.equal(configuredComputerBackend(workspaces, { AGENT0_COMPUTER: 'local' })?.name, 'local');
  assert.throws(
    () => configuredComputerBackend(workspaces, { AGENT0_COMPUTER: 'e2b' }),
    /E2B_API_KEY is required/,
  );
  assert.equal(
    configuredComputerBackend(workspaces, {
      AGENT0_COMPUTER: 'e2b',
      E2B_API_KEY: 'test-key',
    })?.name,
    'e2b',
  );
  assert.throws(
    () => configuredComputerBackend(workspaces, { AGENT0_COMPUTER: 'unknown' }),
    /Unsupported computer backend/,
  );
});
