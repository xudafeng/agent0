import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFileAgentAutomationStore,
  nextAgentAutomationRunAt,
} from '../src/agent-automation.js';

test('Agent automation store persists 12-hour interval schedules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-automation-'));
  const store = createFileAgentAutomationStore(root);
  const now = new Date('2026-10-10T00:00:00.000Z');

  const automation = await store.create({
    name: 'radar',
    prompt: 'Run radar.',
    cwd: '/tmp/radar',
    skillName: 'radar',
    skillRoots: ['/tmp/radar'],
    policy: 'trusted-workspace',
    repeatEveryMs: 12 * 60 * 60 * 1000,
    now,
  });

  assert.equal(automation.state, 'enabled');
  assert.equal(automation.nextRunAt, '2026-10-10T12:00:00.000Z');
  assert.equal(automation.runCount, 0);
  assert.equal(automation.maxRunMs, 6 * 60 * 60 * 1000);
  assert.equal(automation.consecutiveFailures, 0);

  const disabled = await store.cancel(automation.automationId);
  assert.equal(disabled.state, 'disabled');

  const enabled = await store.enable(
    automation.automationId,
    new Date('2026-10-10T03:00:00.000Z'),
  );
  assert.equal(enabled.state, 'enabled');
  assert.equal(enabled.nextRunAt, '2026-10-10T15:00:00.000Z');
});

test('Agent automation supports timezone-aware cron recurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-automation-'));
  const store = createFileAgentAutomationStore(root);

  const automation = await store.create({
    prompt: 'Run radar.',
    cwd: '/tmp/radar',
    cronExpression: '0 */12 * * *',
    timeZone: 'Asia/Shanghai',
    now: new Date('2026-10-10T00:30:00.000Z'),
  });

  assert.equal(automation.nextRunAt, '2026-10-10T04:00:00.000Z');
  assert.equal(
    nextAgentAutomationRunAt(automation, new Date('2026-10-10T04:01:00.000Z')),
    '2026-10-10T16:00:00.000Z',
  );
});

test('Agent automation requires exactly one recurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-automation-'));
  const store = createFileAgentAutomationStore(root);

  await assert.rejects(
    store.create({
      prompt: 'Run.',
      cwd: '/tmp/project',
    }),
    /exactly one recurrence/,
  );

  await assert.rejects(
    store.create({
      prompt: 'Run.',
      cwd: '/tmp/project',
      repeatEveryMs: 1000,
      cronExpression: '* * * * *',
      timeZone: 'UTC',
    }),
    /exactly one recurrence/,
  );
});

test('Agent automation claim lock prevents concurrent workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-automation-'));
  const store = createFileAgentAutomationStore(root);
  const automation = await store.create({
    prompt: 'Run.',
    cwd: '/tmp/project',
    repeatEveryMs: 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const release = await store.claim(automation.automationId);
  assert.ok(release);
  assert.equal(await store.claim(automation.automationId), undefined);

  await release!();
  const releaseAgain = await store.claim(automation.automationId);
  assert.ok(releaseAgain);
  await releaseAgain!();
});


test('Agent automation reclaims a lock owned by a dead process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-automation-'));
  const store = createFileAgentAutomationStore(root);
  const automation = await store.create({
    prompt: 'Run.',
    cwd: '/tmp/project',
    repeatEveryMs: 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const lockDir = join(root, 'locks');
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, `${automation.automationId}.lock`), JSON.stringify({
    automationId: automation.automationId,
    pid: 2147483647,
    claimedAt: '2026-10-10T00:00:00.000Z',
  }), 'utf8');

  const release = await store.claim(automation.automationId);
  assert.ok(release);
  await release!();
});
