import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileMissionStore, formatMission } from '../src/autonomy.js';

test('mission store persists a dependency graph and advances ready tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-autonomy-'));
  const store = createFileMissionStore(root);

  const mission = await store.create('Ship autonomous runtime', [
    { title: 'Research' },
    { title: 'Implement' },
    { title: 'Validate', dependsOn: [0, 1] },
  ]);

  assert.equal(mission.tasks[0]?.status, 'in_progress');
  assert.equal(mission.tasks[1]?.status, 'pending');
  assert.equal(mission.tasks[2]?.status, 'pending');

  await store.updateTask(mission.id, mission.tasks[0]!.id, {
    status: 'completed',
    result: 'Research complete',
  });
  const afterFirst = await store.get(mission.id);
  assert.equal(afterFirst.tasks[1]?.status, 'in_progress');

  await store.updateTask(mission.id, mission.tasks[1]!.id, {
    status: 'completed',
    result: 'Implementation complete',
  });
  const afterSecond = await store.get(mission.id);
  assert.equal(afterSecond.tasks[2]?.status, 'in_progress');

  await store.updateTask(mission.id, mission.tasks[2]!.id, {
    status: 'completed',
    result: 'Validated',
  });
  const completed = await store.get(mission.id);
  assert.equal(completed.status, 'completed');
  assert.ok(formatMission(completed).includes('Ship autonomous runtime'));
});

test('mission store rejects cyclic and unmet task dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-autonomy-'));
  const store = createFileMissionStore(root);

  await assert.rejects(
    store.create('Cyclic', [
      { title: 'A', dependsOn: [1] },
      { title: 'B', dependsOn: [0] },
    ]),
    /cycle/,
  );

  const mission = await store.create('Dependencies', [
    { title: 'A' },
    { title: 'B', dependsOn: [0] },
  ]);

  await assert.rejects(
    store.updateTask(mission.id, mission.tasks[1]!.id, { status: 'in_progress' }),
    /dependencies are not complete/,
  );
});

test('human handoff blocks and later resumes a mission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-autonomy-'));
  const store = createFileMissionStore(root);
  const mission = await store.create('Needs judgment', [{ title: 'Decide' }]);

  const handoff = await store.requestHandoff(
    mission.id,
    'Need product judgment',
    'Should we optimize for speed or quality?',
  );

  assert.equal(handoff.status, 'pending');
  assert.equal((await store.get(mission.id)).status, 'blocked');

  const resolved = await store.resolveHandoff(mission.id, 'Optimize for quality.');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.response, 'Optimize for quality.');
  assert.equal((await store.get(mission.id)).status, 'active');
});
