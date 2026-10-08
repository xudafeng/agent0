import assert from 'node:assert/strict';
import test from 'node:test';
import { createE2BComputerBackend, E2BComputerUnsupportedError } from '../src/e2b-computer.js';
import type { Workspace } from '../src/workspace.js';

function fakeSandbox(id = 'sandbox-1') {
  const files = new Map<string, string>();
  const commands: Array<{ command: string; options: Record<string, unknown> | undefined }> = [];
  let paused = false;
  let connected = false;
  let killed = false;

  return {
    sandbox: {
      sandboxId: id,
      commands: {
        async run(command: string, options?: Record<string, unknown>) {
          commands.push({ command, options });
          return { exitCode: 0, stdout: 'ok\n', stderr: '' };
        },
      },
      files: {
        async read(path: string) {
          const value = files.get(path);
          if (value === undefined) throw new Error('missing');
          return value;
        },
        async write(path: string, value: string) {
          files.set(path, value);
        },
      },
      async pause() {
        paused = true;
        return true;
      },
      async connect() {
        connected = true;
        return this;
      },
      async kill() {
        killed = true;
        return true;
      },
    },
    files,
    commands,
    state: {
      get paused() { return paused; },
      get connected() { return connected; },
      get killed() { return killed; },
    },
  };
}

const workspace: Workspace = {
  id: 'workspace-1',
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
};

test('E2BComputer maps Computer operations to one sandbox workspace', async () => {
  const fake = fakeSandbox();
  const backend = createE2BComputerBackend({
    root: '/home/user/agent0',
    createSandbox: async () => fake.sandbox,
  });

  const computer = await backend.create(workspace);

  assert.deepEqual(computer.ref, {
    backend: 'e2b',
    id: 'sandbox-1',
    workspaceId: 'workspace-1',
  });
  assert.deepEqual(computer.capabilities, {
    persistentFilesystem: true,
    persistentMemory: true,
    pauseResume: true,
    snapshot: false,
    fork: false,
    desktop: false,
  });

  assert.equal(fake.commands[0]?.command, "mkdir -p '/home/user/agent0/workspace-1'");

  await computer.writeTextFile('notes/hello.txt', 'hello e2b');
  assert.equal(
    fake.files.get('/home/user/agent0/workspace-1/notes/hello.txt'),
    'hello e2b',
  );
  assert.equal(await computer.readTextFile('notes/hello.txt'), 'hello e2b');

  const result = await computer.exec({
    command: 'node',
    args: ['-e', 'console.log("hello world")'],
    cwd: 'notes',
    env: { MODE: 'test' },
    timeoutMs: 5000,
  });

  assert.deepEqual(result, { exitCode: 0, stdout: 'ok\n', stderr: '' });
  const exec = fake.commands.at(-1);
  assert.equal(exec?.command, "'node' '-e' 'console.log(\"hello world\")'");
  assert.deepEqual(exec?.options, {
    cwd: '/home/user/agent0/workspace-1/notes',
    envs: { MODE: 'test' },
    timeoutMs: 5000,
  });

  await computer.suspend();
  await computer.resume();
  assert.equal(fake.state.paused, true);
  assert.equal(fake.state.connected, true);

  await assert.rejects(computer.snapshot(), (error) => error instanceof E2BComputerUnsupportedError);

  await computer.destroy();
  assert.equal(fake.state.killed, true);
  await assert.rejects(computer.readTextFile('notes/hello.txt'), /destroyed/);
});

test('E2BComputer reconnects by stable sandbox ID and preserves workspace identity', async () => {
  const fake = fakeSandbox('sandbox-existing');
  let connectedId = '';

  const backend = createE2BComputerBackend({
    connectSandbox: async (sandboxId) => {
      connectedId = sandboxId;
      return fake.sandbox;
    },
  });

  const computer = await backend.reconnect({
    backend: 'e2b',
    id: 'sandbox-existing',
    workspaceId: 'workspace-2',
  });

  assert.equal(connectedId, 'sandbox-existing');
  assert.equal(computer.ref.workspaceId, 'workspace-2');
  assert.equal(computer.ref.id, 'sandbox-existing');
});

test('E2BComputer rejects invalid workspace identity during reconnect', async () => {
  const fake = fakeSandbox('sandbox-existing');
  const backend = createE2BComputerBackend({
    connectSandbox: async () => fake.sandbox,
  });

  await assert.rejects(
    backend.reconnect({
      backend: 'e2b',
      id: 'sandbox-existing',
      workspaceId: '../escape',
    }),
    /Invalid workspace ID/,
  );
});

test('E2BComputer rejects workspace path escapes and safely quotes arguments', async () => {
  const fake = fakeSandbox();
  const computer = await createE2BComputerBackend({
    createSandbox: async () => fake.sandbox,
  }).create(workspace);

  await assert.rejects(computer.readTextFile('../secret'), /escapes/);
  await assert.rejects(computer.writeTextFile('/etc/passwd', 'nope'), /relative/);
  await assert.rejects(
    computer.exec({ command: 'node', cwd: '../', args: [] }),
    /escapes/,
  );

  await computer.exec({ command: 'printf', args: ["a'b"] });
  const command = fake.commands.at(-1)?.command ?? '';
  assert.ok(command.startsWith("'printf' "));
  assert.ok(command.includes("a"));
  assert.ok(command.includes("b"));
  assert.notEqual(command, "printf a'b");
});
