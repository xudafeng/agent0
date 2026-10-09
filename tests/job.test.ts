import assert from 'node:assert/strict';
import test from 'node:test';
import type { Computer, ComputerExecInput } from '../src/computer.js';
import {
  getDurableJobStatus,
  listDurableJobs,
  loadDurableJob,
  readDurableJobOutput,
  reconcileDurableJobs,
  startDurableJob,
} from '../src/job.js';

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
        if (script.includes("printf exists") && script.includes('.agent0/jobs/index.json')) {
          return {
            exitCode: 0,
            stdout: files.has('.agent0/jobs/index.json') ? 'exists' : 'missing',
            stderr: '',
          };
        }
        if (script.startsWith('if [ -f ')) {
          const exitEntry = [...files.entries()].find(([path]) =>
            path.endsWith('/exit-code') && script.includes(path)
          );
          return exitEntry
            ? { exitCode: 0, stdout: exitEntry[1], stderr: '' }
            : { exitCode: 44, stdout: '', stderr: '' };
        }
      }

      if (input.command === 'kill' && input.args?.[0] === '-0') {
        return { exitCode: running ? 0 : 1, stdout: '', stderr: '' };
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

test('durable job persists a stable job record backed by a detached process', async () => {
  const fake = fakeComputer();
  const job = await startDurableJob(fake.computer, {
    command: 'node',
    args: ['worker.js'],
  });

  assert.match(job.jobId, /^[a-zA-Z0-9_-]+$/);
  assert.equal(job.state, 'running');
  assert.match(job.processId ?? '', /^[a-zA-Z0-9_-]+$/);

  const loaded = await loadDurableJob(fake.computer, job.jobId);
  assert.equal(loaded.jobId, job.jobId);
  assert.equal(loaded.processId, job.processId);
  assert.equal(loaded.state, 'running');
});

test('durable job reconciles process completion into succeeded and failed states', async () => {
  const successFake = fakeComputer();
  const success = await startDurableJob(successFake.computer, { command: 'true' });
  successFake.files.set(`.agent0/processes/${success.processId}/exit-code`, '0');
  successFake.setRunning(false);

  const completed = await getDurableJobStatus(successFake.computer, success.jobId);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.exitCode, 0);
  assert.ok(completed.completedAt);

  const failedFake = fakeComputer();
  const failed = await startDurableJob(failedFake.computer, { command: 'false' });
  failedFake.files.set(`.agent0/processes/${failed.processId}/exit-code`, '7');
  failedFake.setRunning(false);

  const failedStatus = await getDurableJobStatus(failedFake.computer, failed.jobId);
  assert.equal(failedStatus.state, 'failed');
  assert.equal(failedStatus.exitCode, 7);
});

test('durable job output survives later turns through persisted process output', async () => {
  const fake = fakeComputer();
  const job = await startDurableJob(fake.computer, { command: 'echo', args: ['hello'] });
  fake.files.set(`.agent0/processes/${job.processId}/stdout.log`, 'hello\n');
  fake.files.set(`.agent0/processes/${job.processId}/stderr.log`, 'warn\n');

  assert.deepEqual(
    await readDurableJobOutput(fake.computer, job.jobId),
    {
      jobId: job.jobId,
      stdout: 'hello\n',
      stderr: 'warn\n',
    },
  );
});

test('durable job index keeps job history and reconciliation updates terminal state', async () => {
  const fake = fakeComputer();

  const first = await startDurableJob(fake.computer, { command: 'echo', args: ['one'] });
  const second = await startDurableJob(fake.computer, { command: 'echo', args: ['two'] });

  fake.files.set('.agent0/jobs/index.json', `${JSON.stringify({
    version: 1,
    jobs: [second, first],
  }, null, 2)}\n`);

  fake.files.set(`.agent0/processes/${first.processId}/exit-code`, '0');
  fake.files.set(`.agent0/processes/${second.processId}/exit-code`, '9');
  fake.setRunning(false);

  const reconciled = await reconcileDurableJobs(fake.computer);
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled.find((job) => job.jobId === first.jobId)?.state, 'succeeded');
  assert.equal(reconciled.find((job) => job.jobId === second.jobId)?.state, 'failed');

  const history = await listDurableJobs(fake.computer);
  assert.equal(history.length, 2);
  assert.equal(history.find((job) => job.jobId === first.jobId)?.exitCode, 0);
  assert.equal(history.find((job) => job.jobId === second.jobId)?.exitCode, 9);
});

