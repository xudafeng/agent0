import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFilePersonalStateStore, formatPersonalState } from '../src/personal-state.js';

test('personal state persists goals tasks focus and notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-personal-'));
  const store = createFilePersonalStateStore(root);

  await store.setDailyFocus('Ship personal agent state');
  const goal = await store.addGoal('Build agent0');
  const task = await store.addTask('Finish personal state PR', goal.id);
  await store.updateTask(task.id, { status: 'in_progress' });
  await store.addNote('Keep the UI compact.');

  const state = await store.get();
  assert.equal(state.dailyFocus, 'Ship personal agent state');
  assert.equal(state.goals[0]?.id, goal.id);
  assert.equal(state.tasks[0]?.status, 'in_progress');
  assert.equal(state.tasks[0]?.goalId, goal.id);
  assert.deepEqual(state.notes, ['Keep the UI compact.']);

  const persisted = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(persisted.tasks[0].title, 'Finish personal state PR');

  const context = formatPersonalState(state);
  assert.ok(context.includes('Daily focus: Ship personal agent state'));
  assert.ok(context.includes('Build agent0'));
  assert.ok(context.includes('Finish personal state PR'));
});

test('personal task completion and goal removal preserve durable task state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-personal-'));
  const store = createFilePersonalStateStore(root);

  const goal = await store.addGoal('Improve agent0');
  const task = await store.addTask('Add personal state', goal.id);
  const completed = await store.updateTask(task.id, { status: 'completed' });

  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);

  await store.removeGoal(goal.id);
  const state = await store.get();
  assert.equal(state.goals.length, 0);
  assert.equal(state.tasks[0]?.id, task.id);
  assert.equal(state.tasks[0]?.goalId, undefined);
  assert.equal(state.tasks[0]?.status, 'completed');
});

test('personal daily journal appends readable markdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-personal-'));
  const store = createFilePersonalStateStore(root);
  const date = new Date('2026-10-10T03:04:05.000Z');

  const path = await store.appendDailyJournal('Finished the memory subsystem.', date);
  await store.appendDailyJournal('Started personal state.', new Date('2026-10-10T04:05:06.000Z'));

  const journal = await readFile(path, 'utf8');
  assert.ok(journal.includes('# 2026-10-10'));
  assert.ok(journal.includes('Finished the memory subsystem.'));
  assert.ok(journal.includes('Started personal state.'));
});
