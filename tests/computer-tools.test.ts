import assert from 'node:assert/strict';
import test from 'node:test';
import type { Computer } from '../src/computer.js';
import { createComputerTools } from '../src/computer-tools.js';
import { createToolRegistry } from '../src/tools.js';

function fakeComputer() {
  const calls: Array<{ type: string; value: unknown }> = [];
  const computer: Computer = {
    ref: { backend: 'fake', id: 'computer-1', workspaceId: 'workspace-1' },
    capabilities: {
      persistentFilesystem: true,
      persistentMemory: false,
      pauseResume: false,
      snapshot: false,
      fork: false,
      desktop: false,
    },
    async exec(input) {
      calls.push({ type: 'exec', value: input });
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    },
    async readTextFile(path) {
      calls.push({ type: 'read', value: path });
      return 'hello';
    },
    async writeTextFile(path, content) {
      calls.push({ type: 'write', value: { path, content } });
    },
    async suspend() {},
    async resume() {},
    async snapshot() { throw new Error('unsupported'); },
    async destroy() {},
  };
  return { computer, calls };
}

test('computer tools expose exec, read, and write operations', async () => {
  const fake = fakeComputer();
  const registry = createToolRegistry(createComputerTools(fake.computer));

  assert.deepEqual(
    registry.definitions.map((tool) => tool.name),
    ['computer_exec', 'computer_read_file', 'computer_write_file'],
  );

  assert.deepEqual(
    await registry.execute({
      id: 'exec-1',
      name: 'computer_exec',
      arguments: {
        command: 'node',
        args: ['-v'],
        cwd: 'app',
        env: { MODE: 'test' },
        timeoutMs: 5000,
      },
    }),
    { exitCode: 0, stdout: 'ok\n', stderr: '' },
  );

  assert.equal(
    await registry.execute({
      id: 'read-1',
      name: 'computer_read_file',
      arguments: { path: 'README.md' },
    }),
    'hello',
  );

  assert.deepEqual(
    await registry.execute({
      id: 'write-1',
      name: 'computer_write_file',
      arguments: { path: 'src/index.ts', content: 'console.log(1);' },
    }),
    { path: 'src/index.ts', bytes: 15 },
  );

  assert.deepEqual(fake.calls, [
    {
      type: 'exec',
      value: {
        command: 'node',
        args: ['-v'],
        cwd: 'app',
        env: { MODE: 'test' },
        timeoutMs: 5000,
      },
    },
    { type: 'read', value: 'README.md' },
    { type: 'write', value: { path: 'src/index.ts', content: 'console.log(1);' } },
  ]);
});

test('computer tools validate malformed arguments', async () => {
  const fake = fakeComputer();
  const registry = createToolRegistry(createComputerTools(fake.computer));

  await assert.rejects(
    registry.execute({
      id: 'bad-exec',
      name: 'computer_exec',
      arguments: { command: '', args: [1] },
    }),
    /non-empty string argument: command/,
  );

  await assert.rejects(
    registry.execute({
      id: 'bad-read',
      name: 'computer_read_file',
      arguments: { path: '' },
    }),
    /non-empty string argument: path/,
  );

  await assert.rejects(
    registry.execute({
      id: 'bad-write',
      name: 'computer_write_file',
      arguments: { path: 'file.txt', content: 1 },
    }),
    /requires string argument: content/,
  );
});
