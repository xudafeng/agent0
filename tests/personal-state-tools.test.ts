import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFilePersonalStateStore } from '../src/personal-state.js';
import { createPersonalStateTools } from '../src/personal-state-tools.js';
import { createToolRegistry } from '../src/tools.js';

test('personal state tools manage persistent goals and tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-personal-tools-'));
  const store = createFilePersonalStateStore(root);
  const registry = createToolRegistry(createPersonalStateTools(store));

  const goal = await registry.execute({
    id: 'goal-1',
    name: 'personal_add_goal',
    arguments: { title: 'Build agent0' },
  }) as { id: string };

  const task = await registry.execute({
    id: 'task-1',
    name: 'personal_add_task',
    arguments: { title: 'Ship personal state', goalId: goal.id },
  }) as { id: string };

  await registry.execute({
    id: 'focus-1',
    name: 'personal_set_focus',
    arguments: { focus: 'Finish the PR' },
  });

  await registry.execute({
    id: 'task-2',
    name: 'personal_update_task',
    arguments: { id: task.id, status: 'completed' },
  });

  const state = await registry.execute({
    id: 'state-1',
    name: 'personal_state',
    arguments: {},
  }) as { dailyFocus: string; tasks: Array<{ id: string; status: string }> };

  assert.equal(state.dailyFocus, 'Finish the PR');
  assert.equal(state.tasks.find((item) => item.id === task.id)?.status, 'completed');
});
