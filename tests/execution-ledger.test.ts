import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFileToolExecutionLedger,
  createToolExecutionId,
  type ToolExecutionRecord,
} from '../src/execution-ledger.js';

test('tool execution id ignores provider call ids and canonicalizes arguments', () => {
  const first = createToolExecutionId('run-1', 2, 0, {
    id: 'provider-a',
    name: 'send',
    arguments: { b: 2, a: { y: 2, x: 1 } },
  });
  const second = createToolExecutionId('run-1', 2, 0, {
    id: 'provider-b',
    name: 'send',
    arguments: { a: { x: 1, y: 2 }, b: 2 },
  });

  assert.equal(first, second);
});

test('file execution ledger saves and reloads durable records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-executions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = createFileToolExecutionLedger(root);
  const record: ToolExecutionRecord = {
    executionId: 'execution-1',
    runId: 'run-1',
    step: 2,
    toolIndex: 0,
    toolCall: { id: 'call-1', name: 'send', arguments: { value: 'x' } },
    idempotency: 'unknown',
    status: 'started',
    startedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };

  assert.equal(await ledger.load('run-1', 'execution-1'), undefined);
  await ledger.save(record);
  assert.deepEqual(await ledger.load('run-1', 'execution-1'), record);

  const completed: ToolExecutionRecord = {
    ...record,
    status: 'completed',
    result: '{"ok":true,"result":"done"}',
    isError: false,
    completedAt: '2026-09-30T00:00:01.000Z',
    updatedAt: '2026-09-30T00:00:01.000Z',
  };
  await ledger.save(completed);
  assert.deepEqual(await ledger.load('run-1', 'execution-1'), completed);

  await assert.rejects(ledger.load('../escape', 'execution-1'), /Invalid run ID/);
  await assert.rejects(ledger.load('run-1', '../escape'), /Invalid execution ID/);
});
