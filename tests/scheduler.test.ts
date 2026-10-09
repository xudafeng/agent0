import assert from 'node:assert/strict';
import test from 'node:test';
import type { Computer, ComputerExecInput } from '../src/computer.js';
import { createDurableScheduler, nextCronRunAt } from '../src/scheduler.js';

function fakeComputer(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  let pid = 4000;
  const execs: ComputerExecInput[] = [];

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
        if (script.includes("printf exists") && script.includes('.agent0/schedules/index.json')) {
          return {
            exitCode: 0,
            stdout: files.has('.agent0/schedules/index.json') ? 'exists' : 'missing',
            stderr: '',
          };
        }
        if (script.includes('nohup sh -lc')) {
          pid += 1;
          return { exitCode: 0, stdout: `${pid}\n`, stderr: '' };
        }
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

  return { computer, files, execs };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('durable scheduler persists and cancels a future one-shot schedule', async (t) => {
  const fake = fakeComputer();
  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());

  const schedule = await scheduler.schedule(
    { command: 'echo', args: ['hello'] },
    new Date(Date.now() + 60_000).toISOString(),
  );

  assert.equal(schedule.state, 'pending');
  assert.match(schedule.scheduleId, /^[a-zA-Z0-9_-]+$/);

  const persisted = JSON.parse(fake.files.get('.agent0/schedules/index.json') ?? '{}');
  assert.equal(persisted.schedules[0].scheduleId, schedule.scheduleId);

  const cancelled = await scheduler.cancel(schedule.scheduleId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await scheduler.get(schedule.scheduleId)).state, 'cancelled');
});

test('durable scheduler starts an overdue schedule after restart', async (t) => {
  const scheduleId = 'schedule-existing';
  const index = {
    version: 1,
    schedules: [{
      scheduleId,
      runAt: new Date(Date.now() - 1_000).toISOString(),
      state: 'pending',
      input: { command: 'echo', args: ['late'] },
      createdAt: new Date(Date.now() - 5_000).toISOString(),
    }],
  };
  const fake = fakeComputer({
    '.agent0/schedules/index.json': `${JSON.stringify(index, null, 2)}\n`,
  });

  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());
  await flushAsyncWork();

  const schedule = await scheduler.get(scheduleId);
  assert.equal(schedule.state, 'started');
  assert.match(schedule.jobId ?? '', /^[a-zA-Z0-9_-]+$/);

  const jobPath = `.agent0/jobs/${schedule.jobId}.json`;
  assert.ok(fake.files.has(jobPath));
});

test('scheduler list survives recreation from workspace state', async () => {
  const fake = fakeComputer();
  const first = await createDurableScheduler(fake.computer);
  const created = await first.schedule(
    { command: 'node', args: ['worker.js'] },
    new Date(Date.now() + 60_000).toISOString(),
  );
  await first.close();

  const second = await createDurableScheduler(fake.computer);
  try {
    const schedules = await second.list();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.scheduleId, created.scheduleId);
    assert.equal(schedules[0]?.state, 'pending');
  } finally {
    await second.close();
  }
});

test('recurring schedule re-arms after each successful trigger', async (t) => {
  const scheduleId = 'recurring-existing';
  const intervalMs = 60_000;
  const index = {
    version: 1,
    schedules: [{
      scheduleId,
      runAt: new Date(Date.now() - 5_000).toISOString(),
      state: 'pending',
      input: { command: 'echo', args: ['tick'] },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      repeatEveryMs: intervalMs,
      runCount: 0,
    }],
  };
  const fake = fakeComputer({
    '.agent0/schedules/index.json': `${JSON.stringify(index, null, 2)}\n`,
  });

  const before = Date.now();
  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());
  await flushAsyncWork();

  const schedule = await scheduler.get(scheduleId);
  assert.equal(schedule.state, 'pending');
  assert.equal(schedule.runCount, 1);
  assert.match(schedule.jobId ?? '', /^[a-zA-Z0-9_-]+$/);

  const nextRun = new Date(schedule.runAt).getTime();
  assert.ok(nextRun >= before + intervalMs);
  assert.ok(nextRun <= Date.now() + intervalMs + 1_000);
});

test('recurring schedule missed while offline catches up once, not once per missed interval', async (t) => {
  const scheduleId = 'recurring-overdue';
  const intervalMs = 1_000;
  const index = {
    version: 1,
    schedules: [{
      scheduleId,
      runAt: new Date(Date.now() - 60_000).toISOString(),
      state: 'pending',
      input: { command: 'echo', args: ['catch-up'] },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      repeatEveryMs: intervalMs,
      runCount: 4,
    }],
  };
  const fake = fakeComputer({
    '.agent0/schedules/index.json': `${JSON.stringify(index, null, 2)}\n`,
  });

  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());
  await flushAsyncWork();

  const schedule = await scheduler.get(scheduleId);
  assert.equal(schedule.runCount, 5);
  assert.equal(schedule.state, 'pending');

  const jobs = [...fake.files.keys()].filter((path) =>
    path.startsWith('.agent0/jobs/') && path !== '.agent0/jobs/index.json'
  );
  assert.equal(jobs.length, 1);
});

test('recurring schedule can be cancelled between runs', async (t) => {
  const fake = fakeComputer();
  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());

  const schedule = await scheduler.schedule(
    { command: 'echo', args: ['tick'] },
    new Date(Date.now() + 60_000).toISOString(),
    60_000,
  );

  assert.equal(schedule.repeatEveryMs, 60_000);
  assert.equal(schedule.runCount, 0);

  const cancelled = await scheduler.cancel(schedule.scheduleId);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.repeatEveryMs, 60_000);
});

test('cron schedules compute the next run in the requested timezone', () => {
  const current = '2026-10-09T23:00:00.000Z';

  assert.equal(
    nextCronRunAt('0 9 * * *', 'Asia/Tokyo', current),
    '2026-10-10T00:00:00.000Z',
  );
  assert.equal(
    nextCronRunAt('0 9 * * *', 'UTC', current),
    '2026-10-10T09:00:00.000Z',
  );
});

test('cron schedule persists expression and timezone', async (t) => {
  const fake = fakeComputer();
  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());

  const schedule = await scheduler.scheduleCron(
    { command: 'echo', args: ['morning'] },
    '0 9 * * *',
    'Asia/Tokyo',
  );

  assert.equal(schedule.state, 'pending');
  assert.equal(schedule.cronExpression, '0 9 * * *');
  assert.equal(schedule.timeZone, 'Asia/Tokyo');
  assert.equal(schedule.runCount, 0);
  assert.ok(new Date(schedule.runAt).getTime() > Date.now());

  const persisted = JSON.parse(fake.files.get('.agent0/schedules/index.json') ?? '{}');
  assert.equal(persisted.schedules[0].cronExpression, '0 9 * * *');
  assert.equal(persisted.schedules[0].timeZone, 'Asia/Tokyo');
});

test('overdue cron schedule catches up once and computes its next cron occurrence', async (t) => {
  const scheduleId = 'cron-overdue';
  const index = {
    version: 1,
    schedules: [{
      scheduleId,
      runAt: new Date(Date.now() - 60_000).toISOString(),
      state: 'pending',
      input: { command: 'echo', args: ['cron'] },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      cronExpression: '* * * * *',
      timeZone: 'Asia/Tokyo',
      runCount: 2,
    }],
  };
  const fake = fakeComputer({
    '.agent0/schedules/index.json': `${JSON.stringify(index, null, 2)}\n`,
  });

  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());
  await flushAsyncWork();

  const schedule = await scheduler.get(scheduleId);
  assert.equal(schedule.state, 'pending');
  assert.equal(schedule.runCount, 3);
  assert.equal(schedule.cronExpression, '* * * * *');
  assert.equal(schedule.timeZone, 'Asia/Tokyo');
  assert.ok(new Date(schedule.runAt).getTime() > Date.now());

  const jobs = [...fake.files.keys()].filter((path) =>
    path.startsWith('.agent0/jobs/') && path !== '.agent0/jobs/index.json'
  );
  assert.equal(jobs.length, 1);
});

test('cron schedule rejects invalid timezone or expression', async (t) => {
  const fake = fakeComputer();
  const scheduler = await createDurableScheduler(fake.computer);
  t.after(() => scheduler.close());

  await assert.rejects(
    scheduler.scheduleCron({ command: 'echo' }, 'not a cron', 'Asia/Tokyo'),
  );
  await assert.rejects(
    scheduler.scheduleCron({ command: 'echo' }, '0 9 * * *', 'Mars/Olympus'),
  );
});

