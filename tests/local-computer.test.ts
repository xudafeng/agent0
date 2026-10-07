import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createLocalComputerBackend,
  LocalComputerTimeoutError,
  LocalComputerUnsupportedError,
} from '../src/local-computer.js';
import { createFileWorkspaceStore } from '../src/workspace.js';

test('LocalComputer executes commands inside a persistent workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-local-computer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileWorkspaceStore(root);
  const workspace = await store.create('local-1');
  const backend = createLocalComputerBackend(store);
  const computer = await backend.create(workspace);

  assert.equal(computer.ref.backend, 'local');
  assert.equal(computer.ref.workspaceId, workspace.id);
  assert.deepEqual(computer.capabilities, {
    persistentFilesystem: true,
    persistentMemory: false,
    pauseResume: false,
    snapshot: false,
    fork: false,
    desktop: false,
  });

  await computer.writeTextFile('notes/hello.txt', 'hello local computer');
  assert.equal(await computer.readTextFile('notes/hello.txt'), 'hello local computer');

  const result = await computer.exec({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.cwd())'],
    cwd: 'notes',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, join(store.directory(workspace.id), 'files', 'notes'));

  const reconnected = await backend.reconnect(computer.ref);
  assert.equal(await reconnected.readTextFile('notes/hello.txt'), 'hello local computer');
});

test('LocalComputer confines file and cwd paths to workspace files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-local-computer-paths-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent0-local-computer-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const store = createFileWorkspaceStore(root);
  const workspace = await store.create('local-2');
  const backend = createLocalComputerBackend(store);
  const computer = await backend.create(workspace);

  await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8');
  await writeFile(join(outside, 'target.txt'), 'outside target', 'utf8');
  await symlink(outside, join(store.directory(workspace.id), 'files', 'escape'));
  await symlink(join(outside, 'target.txt'), join(store.directory(workspace.id), 'files', 'escape-file'));

  await assert.rejects(computer.readTextFile('../workspace.json'), /relative|escapes/);
  await assert.rejects(computer.readTextFile('escape/secret.txt'), /escapes/);
  await assert.rejects(computer.writeTextFile('escape/new.txt', 'nope'), /escapes/);
  await assert.rejects(computer.writeTextFile('escape-file', 'nope'), /escapes/);
  await assert.rejects(
    computer.exec({ command: process.execPath, args: ['-e', ''], cwd: '../' }),
    /relative|escapes/,
  );
});

test('LocalComputer supports timeout and cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-local-computer-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileWorkspaceStore(root);
  const workspace = await store.create('local-3');
  const computer = await createLocalComputerBackend(store).create(workspace);

  await assert.rejects(
    computer.exec({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      timeoutMs: 30,
    }),
    (error) => error instanceof LocalComputerTimeoutError,
  );

  const controller = new AbortController();
  const running = computer.exec({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 1000)'],
  }, controller.signal);
  controller.abort(new Error('stop local command'));
  await assert.rejects(running, /stop local command/);
});

test('LocalComputer unsupported lifecycle operations are explicit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-local-computer-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileWorkspaceStore(root);
  const workspace = await store.create('local-4');
  const computer = await createLocalComputerBackend(store).create(workspace);

  await assert.rejects(computer.suspend(), (error) => error instanceof LocalComputerUnsupportedError);
  await assert.rejects(computer.resume(), (error) => error instanceof LocalComputerUnsupportedError);
  await assert.rejects(computer.snapshot(), (error) => error instanceof LocalComputerUnsupportedError);

  await computer.destroy();
  await assert.rejects(computer.readTextFile('anything.txt'), /destroyed/);
});
