import assert from 'node:assert/strict';
import test from 'node:test';
import type { Computer, ComputerBackend, ComputerRef } from '../src/computer.js';
import { runWakeCycle } from '../src/background-runtime.js';
import type { SessionStore, SessionSummary } from '../src/session-store.js';
import type { Workspace, WorkspaceStore } from '../src/workspace.js';

function makeComputer(ref: ComputerRef, files: Map<string, string>, due = false): Computer {
  return {
    ref,
    capabilities: {
      persistentFilesystem: true,
      persistentMemory: true,
      pauseResume: true,
      snapshot: false,
      fork: false,
      desktop: false,
    },
    async exec(input) {
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
          return { exitCode: 0, stdout: '4242\n', stderr: '' };
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
    async suspend() {
      files.set('__suspended__', 'true');
    },
    async resume() {},
    async snapshot() { throw new Error('unsupported'); },
    async destroy() {},
  };
}

function sessionStore(items: SessionSummary[]): SessionStore {
  return {
    async list() { return structuredClone(items); },
    async active() { return items[0]?.id; },
    async create() { throw new Error('unused'); },
    async load() { return undefined; },
    async save() {},
    async rename() { throw new Error('unused'); },
    async bindComputer() { throw new Error('unused'); },
    async remove() {},
    async setActive() {},
  };
}

function workspaceStore(items: Workspace[]): WorkspaceStore {
  const map = new Map(items.map((item) => [item.id, item]));
  return {
    async create() { throw new Error('unused'); },
    async load(id) { return map.get(id); },
    directory(id) { return `/tmp/${id}`; },
  };
}

test('wake cycle reconnects session computers and triggers due schedules', async () => {
  const now = new Date('2026-10-10T00:00:00.000Z');
  const ref: ComputerRef = { backend: 'fake', id: 'computer-1', workspaceId: 'workspace-1' };
  const files = new Map<string, string>();
  files.set('.agent0/schedules/index.json', JSON.stringify({
    version: 1,
    schedules: [{
      scheduleId: 'schedule-1',
      runAt: '2026-10-09T23:59:00.000Z',
      state: 'pending',
      input: { command: 'echo', args: ['wake'] },
      createdAt: '2026-10-09T23:00:00.000Z',
    }],
  }));

  const backend: ComputerBackend = {
    name: 'fake',
    async create() { throw new Error('unused'); },
    async reconnect(computerRef) {
      return makeComputer(computerRef, files, true);
    },
  };

  const result = await runWakeCycle(
    sessionStore([{
      id: 'session-1',
      title: 'Session',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      workspaceId: 'workspace-1',
      computerRef: ref,
    }]),
    workspaceStore([{
      id: 'workspace-1',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }]),
    backend,
    now,
  );

  assert.deepEqual(result.sessions[0]?.triggered, ['schedule-1']);
  assert.equal(files.get('__suspended__'), 'true');
  assert.ok([...files.keys()].some((path) => path.startsWith('.agent0/jobs/')));
});

test('wake cycle isolates session errors and reports earliest next wake', async () => {
  const now = new Date('2026-10-10T00:00:00.000Z');
  const refs: ComputerRef[] = [
    { backend: 'fake', id: 'computer-1', workspaceId: 'workspace-1' },
    { backend: 'fake', id: 'computer-2', workspaceId: 'workspace-2' },
  ];
  const stores = new Map<string, Map<string, string>>();

  for (const [index, ref] of refs.entries()) {
    const files = new Map<string, string>();
    files.set('.agent0/schedules/index.json', JSON.stringify({
      version: 1,
      schedules: [{
        scheduleId: `schedule-${index + 1}`,
        runAt: index === 0 ? '2026-10-10T02:00:00.000Z' : '2026-10-10T01:00:00.000Z',
        state: 'pending',
        input: { command: 'echo' },
        createdAt: '2026-10-09T23:00:00.000Z',
      }],
    }));
    stores.set(ref.id, files);
  }

  const backend: ComputerBackend = {
    name: 'fake',
    async create() { throw new Error('unused'); },
    async reconnect(ref) {
      if (ref.id === 'broken') throw new Error('connect failed');
      const files = stores.get(ref.id);
      if (!files) throw new Error('missing store');
      return makeComputer(ref, files);
    },
  };

  const summaries: SessionSummary[] = refs.map((ref, index) => ({
    id: `session-${index + 1}`,
    title: 'Session',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    workspaceId: ref.workspaceId,
    computerRef: ref,
  }));
  summaries.push({
    id: 'session-broken',
    title: 'Broken',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    workspaceId: 'workspace-broken',
    computerRef: { backend: 'fake', id: 'broken', workspaceId: 'workspace-broken' },
  });

  const result = await runWakeCycle(
    sessionStore(summaries),
    workspaceStore([
      { id: 'workspace-1', createdAt: now.toISOString(), updatedAt: now.toISOString() },
      { id: 'workspace-2', createdAt: now.toISOString(), updatedAt: now.toISOString() },
      { id: 'workspace-broken', createdAt: now.toISOString(), updatedAt: now.toISOString() },
    ]),
    backend,
    now,
  );

  assert.equal(result.nextWakeAt, '2026-10-10T01:00:00.000Z');
  assert.match(result.sessions.find((item) => item.sessionId === 'session-broken')?.error ?? '', /connect failed/);
});
