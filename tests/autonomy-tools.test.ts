import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileArtifactStore } from '../src/artifact.js';
import { createAutonomyTools } from '../src/autonomy-tools.js';
import { createFileMissionStore } from '../src/autonomy.js';
import type { Provider } from '../src/provider.js';
import { createToolRegistry } from '../src/tools.js';

test('parallel delegation executes concurrently and commits every result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-autonomy-tools-'));
  const missions = createFileMissionStore(join(root, 'missions'));
  const artifacts = createFileArtifactStore(join(root, 'artifacts'));
  const mission = await missions.create('Parallel work', [
    { title: 'Alpha' },
    { title: 'Beta' },
    { title: 'Merge', dependsOn: [0, 1] },
  ]);

  let active = 0;
  let maxActive = 0;
  const provider: Provider = {
    async generate(messages) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const task = messages.find((message) => message.role === 'user');
      return {
        text: task && 'content' in task ? `done: ${task.content.split('Task: ')[1]}` : 'done',
        id: 'subagent',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const registry = createToolRegistry(createAutonomyTools(missions, artifacts, provider));
  const result = await registry.execute({
    id: 'delegate',
    name: 'autonomy_delegate_parallel',
    arguments: {
      missionId: mission.id,
      taskIds: [mission.tasks[0]!.id, mission.tasks[1]!.id],
    },
  }) as Array<{ taskId: string }>;

  assert.equal(result.length, 2);
  assert.equal(maxActive, 2);

  const updated = await missions.get(mission.id);
  assert.equal(updated.tasks[0]?.status, 'completed');
  assert.equal(updated.tasks[1]?.status, 'completed');
  assert.equal(updated.tasks[2]?.status, 'in_progress');
  assert.ok(updated.tasks[0]?.result?.includes('Alpha'));
  assert.ok(updated.tasks[1]?.result?.includes('Beta'));
});

test('autonomy tools attach artifacts and persist evaluator results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-autonomy-tools-'));
  const missions = createFileMissionStore(join(root, 'missions'));
  const artifacts = createFileArtifactStore(join(root, 'artifacts'));
  const mission = await missions.create('Produce report', [{ title: 'Write report' }]);

  const provider: Provider = {
    async generate() {
      return {
        text: '{"score":0.9,"summary":"Strong result with minor gaps."}',
        id: 'eval',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const registry = createToolRegistry(createAutonomyTools(missions, artifacts, provider));
  const artifact = await registry.execute({
    id: 'artifact',
    name: 'artifact_create',
    arguments: {
      missionId: mission.id,
      title: 'Final report',
      kind: 'markdown',
      content: '# Report',
    },
  }) as { id: string };

  await registry.execute({
    id: 'evaluate',
    name: 'autonomy_evaluate',
    arguments: {
      missionId: mission.id,
      criteria: ['Accurate', 'Complete'],
    },
  });

  const updated = await missions.get(mission.id);
  assert.deepEqual(updated.artifactIds, [artifact.id]);
  assert.equal(updated.evaluation?.score, 0.9);
  assert.equal(updated.evaluation?.summary, 'Strong result with minor gaps.');
});
