import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeadlessToolPolicy } from '../src/agent-run.js';

test('trusted headless workspace cannot mutate Agent automation schedules', async () => {
  const policy = createHeadlessToolPolicy('trusted-workspace');
  const decision = await policy({
    id: 'schedule',
    name: 'schedule_agent_run',
    arguments: {
      prompt: 'Run.',
      cwd: '/tmp/project',
      repeatEveryMs: 1000,
    },
  }, {});

  assert.equal(decision.action, 'deny');
  if (decision.action === 'deny') {
    assert.match(decision.reason, /interactive approval|explicit CLI/);
  }
});
