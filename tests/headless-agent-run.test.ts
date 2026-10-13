import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHeadlessAgent } from '../src/agent-run.js';
import { createFileAgentRunStore } from '../src/agent-run-store.js';
import { createFileRunStore } from '../src/run-store.js';
import { createFileSessionStore } from '../src/session-store.js';
import type { Message, Provider } from '../src/provider.js';

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test('headless run preloads a standalone skill and writes inside the external workspace', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const project = await mkdtemp(join(tmpdir(), 'agent0-project-'));
  await writeFile(join(project, 'SKILL.md'), [
    '---',
    'name: radar',
    'description: Scan AI trends.',
    '---',
    '',
    '# Radar',
    '',
    'Always produce a report in archive/report.md.',
  ].join('\n'), 'utf8');

  let calls = 0;
  const provider: Provider = {
    async generate(messages, tools = []) {
      calls += 1;
      const system = messages.find((message) => message.role === 'system');
      assert.ok(system && 'content' in system);
      if (!system || !('content' in system)) throw new Error('missing system context');
      assert.ok(system.content.includes('Loaded skill radar:'));
      assert.ok(system.content.includes('Current computer: local-directory backend'));
      assert.ok(tools.some((tool) => tool.name === 'computer_write_file'));

      if (calls === 1) {
        return {
          toolCalls: [{
            id: 'write-report',
            name: 'computer_write_file',
            arguments: {
              path: 'archive/report.md',
              content: '# Radar\n\nReport body.',
            },
          }],
          id: 'response-1',
          model: 'fake',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }

      assert.ok(messages.some((message) =>
        message.role === 'tool'
        && message.toolCallId === 'write-report'
        && message.content.includes('\"ok\":true')
      ));
      return {
        text: 'radar complete',
        id: 'response-2',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const result = await runHeadlessAgent({
    profileDir: profile,
    cwd: project,
    skillName: 'radar',
    skillRoots: [project],
    policy: 'trusted-workspace',
    prompt: 'Run the radar workflow.',
    provider,
    exaClient: null,
  });

  assert.equal(result.text, 'radar complete');
  assert.equal(result.record.status, 'completed');
  assert.ok(result.record.runtimeRunId);
  assert.equal(
    await readFile(join(project, 'archive', 'report.md'), 'utf8'),
    '# Radar\n\nReport body.',
  );
  assert.equal(await missing(join(project, 'data')), true);
  assert.equal(await missing(join(project, '.agent0', 'schedules')), true);

  const runStore = createFileAgentRunStore(join(profile, 'data', 'agent-runs'));
  assert.equal((await runStore.load(result.record.agentRunId))?.status, 'completed');

  const sessions = createFileSessionStore(
    join(profile, 'data', 'headless-sessions'),
    join(profile, 'data', 'headless-session.json'),
  );
  const snapshot = await sessions.load(result.record.sessionId);
  assert.equal(snapshot?.history.at(-1)?.content, 'radar complete');
  assert.ok(snapshot?.runtime.skills.includes('radar'));
});

test('read-only headless policy blocks workspace mutation without blocking the run', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const project = await mkdtemp(join(tmpdir(), 'agent0-project-'));

  let calls = 0;
  const provider: Provider = {
    async generate(messages) {
      calls += 1;
      if (calls === 1) {
        return {
          toolCalls: [{
            id: 'write-blocked',
            name: 'computer_write_file',
            arguments: { path: 'blocked.txt', content: 'nope' },
          }],
          id: 'response-1',
          model: 'fake',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }

      assert.ok(messages.some((message) =>
        message.role === 'tool'
        && message.toolCallId === 'write-blocked'
        && message.content.includes('read-only headless policy')
      ));
      return {
        text: 'write was blocked',
        id: 'response-2',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const result = await runHeadlessAgent({
    profileDir: profile,
    cwd: project,
    policy: 'read-only',
    prompt: 'Try to write a file.',
    provider,
    exaClient: null,
  });

  assert.equal(result.text, 'write was blocked');
  assert.equal(await missing(join(project, 'blocked.txt')), true);
});

test('headless sessions continue conversation context across separate runs', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));

  const firstProvider: Provider = {
    async generate() {
      return {
        text: 'first answer',
        id: 'first',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
  const first = await runHeadlessAgent({
    profileDir: profile,
    prompt: 'first question',
    provider: firstProvider,
    exaClient: null,
  });

  let seen: Message[] = [];
  const secondProvider: Provider = {
    async generate(messages) {
      seen = structuredClone(messages);
      return {
        text: 'second answer',
        id: 'second',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
  const second = await runHeadlessAgent({
    profileDir: profile,
    sessionId: first.record.sessionId,
    prompt: 'second question',
    provider: secondProvider,
    exaClient: null,
  });

  assert.equal(second.record.sessionId, first.record.sessionId);
  assert.ok(seen.some((message) =>
    message.role === 'user' && 'content' in message && message.content === 'first question'
  ));
  assert.ok(seen.some((message) =>
    message.role === 'assistant' && 'content' in message && message.content === 'first answer'
  ));
  assert.ok(seen.some((message) =>
    message.role === 'user' && 'content' in message && message.content === 'second question'
  ));
});

test('a crashed running AgentRun can resume from its runtime checkpoint', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'agent0-profile-'));
  const data = join(profile, 'data');
  const sessions = createFileSessionStore(
    join(data, 'headless-sessions'),
    join(data, 'headless-session.json'),
  );
  const session = await sessions.create('Resume test');

  const now = new Date().toISOString();
  const runtimeRunId = 'runtime_resume_1';
  await createFileRunStore(join(data, 'runs')).save({
    runId: runtimeRunId,
    status: 'running',
    prompt: 'resume this work',
    step: 0,
    messages: [{ role: 'user', content: 'resume this work' }],
    createdAt: now,
    updatedAt: now,
  });

  const agentRuns = createFileAgentRunStore(join(data, 'agent-runs'));
  const record = await agentRuns.create({
    trigger: 'manual',
    status: 'running',
    prompt: 'resume this work',
    sessionId: session.id,
    skillRoots: [],
    policy: 'read-only',
    runtimeRunId,
  });

  const provider: Provider = {
    async generate(messages) {
      assert.ok(messages.some((message) =>
        message.role === 'user' && 'content' in message && message.content === 'resume this work'
      ));
      return {
        text: 'resumed result',
        id: 'resumed',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };

  const resumed = await runHeadlessAgent({
    profileDir: profile,
    resumeAgentRunId: record.agentRunId,
    provider,
    exaClient: null,
  });

  assert.equal(resumed.text, 'resumed result');
  assert.equal(resumed.record.status, 'completed');
  assert.equal(resumed.record.runtimeRunId, runtimeRunId);

  const snapshot = await sessions.load(session.id);
  assert.deepEqual(snapshot?.history.map((message) => message.content), [
    'resume this work',
    'resumed result',
  ]);
});
