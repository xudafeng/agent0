import assert from 'node:assert/strict';
import test from 'node:test';
import type { Computer, ComputerExecInput } from '../src/computer.js';
import {
  getDetachedProcessStatus,
  readDetachedProcessOutput,
  startDetachedProcess,
} from '../src/computer-process.js';

function fakeComputer() {
  const files = new Map<string, string>();
  const execs: ComputerExecInput[] = [];
  let running = true;

  const computer: Computer = {
    ref: { backend: 'fake', id: 'computer-1', workspaceId: 'workspace-1' },
    capabilities: {
      persistentFilesystem: true,
      persistentMemory: true,
      pauseResume: true,
      snapshot: false,
      fork: false,
      desktop: false,
    },
    async exec(input) {
      execs.push(input);

      if (input.command === 'sh' && input.args?.[0] === '-lc') {
        const script = input.args[1] ?? '';
        if (script.includes('nohup sh -lc')) {
          return { exitCode: 0, stdout: '4242\n', stderr: '' };
        }
        if (script.startsWith('if [ -f ')) {
          const exitEntry = [...files.entries()].find(([path]) => path.endsWith('/exit-code'));
          return exitEntry
            ? { exitCode: 0, stdout: exitEntry[1], stderr: '' }
            : { exitCode: 44, stdout: '', stderr: '' };
        }
      }

      if (input.command === 'kill' && input.args?.[0] === '-0') {
        return { exitCode: running ? 0 : 1, stdout: '', stderr: '' };
      }

      if (input.command === 'pwd') {
        return { exitCode: 0, stdout: '/workspace/app\n', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async readTextFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing file: ${path}`);
      return value;
    },
    async writeTextFile(path, content) {
      files.set(path, content);
    },
    async suspend() {},
    async resume() {},
    async snapshot() { throw new Error('unsupported'); },
    async destroy() {},
  };

  return {
    computer,
    files,
    execs,
    setRunning(value: boolean) { running = value; },
  };
}

test('detached process keeps a durable handle and captured output paths', async () => {
  const fake = fakeComputer();
  const handle = await startDetachedProcess(fake.computer, {
    command: 'node',
    args: ['worker.js'],
    cwd: 'app',
    env: { MODE: 'test' },
  });

  assert.match(handle.processId, /^[a-zA-Z0-9_-]+$/);
  const base = `.agent0/processes/${handle.processId}`;
  assert.equal(fake.files.get(`${base}/pid`), '4242');
  assert.equal(fake.files.get(`${base}/stdout.log`), '');
  assert.equal(fake.files.get(`${base}/stderr.log`), '');

  const launcher = fake.execs.find((input) =>
    input.command === 'sh' && input.args?.[1]?.includes('nohup sh -lc'),
  );
  assert.ok(launcher);
  assert.equal(launcher.cwd, 'app');
  assert.deepEqual(launcher.env, { MODE: 'test' });
  assert.ok(launcher.args?.[1]?.includes('node'));
  assert.ok(launcher.args?.[1]?.includes('worker.js'));
  assert.ok(launcher.args?.[1]?.includes('nohup sh -lc'));
});

test('detached process status survives reconnect through workspace files', async () => {
  const fake = fakeComputer();
  const handle = await startDetachedProcess(fake.computer, { command: 'sleep', args: ['30'] });

  assert.deepEqual(
    await getDetachedProcessStatus(fake.computer, handle.processId),
    { processId: handle.processId, state: 'running' },
  );

  const base = `.agent0/processes/${handle.processId}`;
  fake.files.set(`${base}/exit-code`, '0');
  fake.setRunning(false);

  assert.deepEqual(
    await getDetachedProcessStatus(fake.computer, handle.processId),
    { processId: handle.processId, state: 'completed', exitCode: 0 },
  );
});

test('detached process output reads captured stdout and stderr', async () => {
  const fake = fakeComputer();
  const handle = await startDetachedProcess(fake.computer, { command: 'echo', args: ['hello'] });
  const base = `.agent0/processes/${handle.processId}`;
  fake.files.set(`${base}/stdout.log`, 'hello\n');
  fake.files.set(`${base}/stderr.log`, 'warn\n');

  assert.deepEqual(
    await readDetachedProcessOutput(fake.computer, handle.processId),
    {
      processId: handle.processId,
      stdout: 'hello\n',
      stderr: 'warn\n',
    },
  );
});
