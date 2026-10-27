import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileAgentAutomationStore } from '../src/agent-automation.js';
import { preflightAgentAutomation } from '../src/agent-automation-preflight.js';

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('automation preflight validates cwd, standalone skill, provider, and Exa', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-preflight-'));
  const project = join(root, 'radar');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(project, { recursive: true }));
  await writeFile(join(project, 'SKILL.md'), [
    '---',
    'name: radar',
    'description: Scan AI trends.',
    '---',
    '',
    '# Radar',
    '',
    'Run the radar workflow.',
  ].join('\n'), 'utf8');

  const snapshot = {
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY,
  };
  t.after(() => restoreEnv(snapshot));

  process.env.LLM_PROVIDER = 'openai';
  process.env.OPENAI_MODEL = 'test-model';
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.EXA_API_KEY = 'test-exa-key';

  const store = createFileAgentAutomationStore(join(root, 'automations'));
  const automation = await store.create({
    name: 'radar',
    prompt: 'Run radar.',
    cwd: project,
    skillName: 'radar',
    skillRoots: [project],
    policy: 'trusted-workspace',
    repeatEveryMs: 12 * 60 * 60 * 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const result = await preflightAgentAutomation(automation);

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((item) => item.name === 'cwd')?.status, 'pass');
  assert.equal(result.checks.find((item) => item.name === 'skill')?.status, 'pass');
  assert.equal(result.checks.find((item) => item.name === 'provider')?.status, 'pass');
  assert.equal(result.checks.find((item) => item.name === 'exa')?.status, 'pass');
});

test('automation preflight fails fast for a missing cwd and missing provider config', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent0-preflight-'));
  const snapshot = {
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    MOONSHOT_MODEL: process.env.MOONSHOT_MODEL,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    MOONSHOT_BASE_URL: process.env.MOONSHOT_BASE_URL,
    EXA_API_KEY: process.env.EXA_API_KEY,
  };
  t.after(() => restoreEnv(snapshot));

  delete process.env.LLM_PROVIDER;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MOONSHOT_MODEL;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_BASE_URL;
  delete process.env.EXA_API_KEY;

  const store = createFileAgentAutomationStore(join(root, 'automations'));
  const automation = await store.create({
    prompt: 'Run.',
    cwd: join(root, 'missing'),
    repeatEveryMs: 1000,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });

  const result = await preflightAgentAutomation(automation);

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.name === 'cwd')?.status, 'fail');
  assert.equal(result.checks.find((item) => item.name === 'provider')?.status, 'fail');
  assert.equal(result.checks.find((item) => item.name === 'exa')?.status, 'warn');
});
