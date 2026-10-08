import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ComputerRef } from './computer.js';
import type { RuntimeSessionState } from './runtime.js';

export interface SessionHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  steps?: number;
}

export interface SessionSnapshot {
  version: 1;
  history: SessionHistoryMessage[];
  runtime: RuntimeSessionState;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
  computerRef?: ComputerRef;
}

interface SessionIndex {
  version: 1;
  activeSessionId?: string;
  sessions: SessionSummary[];
}

export interface SessionStore {
  list(): Promise<SessionSummary[]>;
  active(): Promise<string | undefined>;
  create(title?: string): Promise<SessionSummary>;
  load(id: string): Promise<SessionSnapshot | undefined>;
  save(id: string, snapshot: SessionSnapshot): Promise<void>;
  rename(id: string, title: string): Promise<SessionSummary>;
  bindComputer(id: string, workspaceId: string, computerRef: ComputerRef): Promise<SessionSummary>;
  remove(id: string): Promise<void>;
  setActive(id: string | undefined): Promise<void>;
}

function assertSessionId(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid session ID.');
}

function assertWorkspaceId(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid workspace ID.');
}

function validateComputerBinding(workspaceId: unknown, computerRef: unknown): void {
  if (workspaceId === undefined && computerRef === undefined) return;
  if (typeof workspaceId !== 'string' || !computerRef || typeof computerRef !== 'object') {
    throw new Error('Invalid session computer binding.');
  }
  assertWorkspaceId(workspaceId);
  const ref = computerRef as Partial<ComputerRef>;
  if (typeof ref.backend !== 'string' || !ref.backend || typeof ref.id !== 'string' || !ref.id ||
      typeof ref.workspaceId !== 'string' || ref.workspaceId !== workspaceId) {
    throw new Error('Invalid session computer binding.');
  }
  assertWorkspaceId(ref.workspaceId);
}

function normalizeTitle(title: string): string {
  const value = title.trim() || 'New conversation';
  if (value.length > 120) throw new Error('Session title must contain 1 to 120 characters.');
  return value;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function validateSnapshot(parsed: unknown): SessionSnapshot {
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid session snapshot.');
  const snapshot = parsed as Partial<SessionSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.history) || !snapshot.runtime || typeof snapshot.updatedAt !== 'string') {
    throw new Error('Invalid session snapshot.');
  }
  return snapshot as SessionSnapshot;
}

function validateIndex(parsed: unknown): SessionIndex {
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid session index.');
  const index = parsed as Partial<SessionIndex>;
  if (index.version !== 1 || !Array.isArray(index.sessions)) throw new Error('Invalid session index.');
  for (const session of index.sessions) {
    if (!session || typeof session !== 'object') throw new Error('Invalid session index.');
    const value = session as Partial<SessionSummary>;
    if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
      throw new Error('Invalid session index.');
    }
    assertSessionId(value.id);
    validateComputerBinding(value.workspaceId, value.computerRef);
  }
  if (index.activeSessionId !== undefined) {
    if (typeof index.activeSessionId !== 'string') throw new Error('Invalid session index.');
    assertSessionId(index.activeSessionId);
    if (!index.sessions.some((session) => session.id === index.activeSessionId)) throw new Error('Invalid session index.');
  }
  return index as SessionIndex;
}

export function createFileSessionStore(
  root = 'data/sessions',
  legacyPath = 'data/session.json',
): SessionStore {
  const indexPath = join(root, 'index.json');
  const snapshotPath = (id: string) => {
    assertSessionId(id);
    return join(root, `${id}.json`);
  };

  const loadIndex = async (): Promise<SessionIndex> => {
    const existing = await readJson<unknown>(indexPath);
    if (existing) return validateIndex(existing);

    const legacy = await readJson<unknown>(legacyPath);
    if (!legacy) return { version: 1, sessions: [] };

    const snapshot = validateSnapshot(legacy);
    const now = snapshot.updatedAt;
    const session: SessionSummary = {
      id: randomUUID(),
      title: snapshot.history[0]?.content.slice(0, 48).trim() || 'Conversation',
      createdAt: now,
      updatedAt: now,
    };
    await atomicWrite(snapshotPath(session.id), snapshot);
    const migrated: SessionIndex = {
      version: 1,
      activeSessionId: session.id,
      sessions: [session],
    };
    await atomicWrite(indexPath, migrated);
    await rm(legacyPath, { force: true });
    return migrated;
  };

  const saveIndex = (index: SessionIndex) => atomicWrite(indexPath, index);

  return {
    async list() {
      return structuredClone((await loadIndex()).sessions);
    },

    async active() {
      return (await loadIndex()).activeSessionId;
    },

    async create(title = 'New conversation') {
      const index = await loadIndex();
      const now = new Date().toISOString();
      const session: SessionSummary = {
        id: randomUUID(),
        title: normalizeTitle(title),
        createdAt: now,
        updatedAt: now,
      };
      index.sessions.unshift(session);
      index.activeSessionId = session.id;
      await saveIndex(index);
      return structuredClone(session);
    },

    async load(id) {
      assertSessionId(id);
      const parsed = await readJson<unknown>(snapshotPath(id));
      return parsed ? validateSnapshot(parsed) : undefined;
    },

    async save(id, snapshot) {
      assertSessionId(id);
      const index = await loadIndex();
      const session = index.sessions.find((item) => item.id === id);
      if (!session) throw new Error(`Unknown session: ${id}`);
      const validated = validateSnapshot(snapshot);
      await atomicWrite(snapshotPath(id), validated);
      session.updatedAt = validated.updatedAt;
      index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      index.activeSessionId = id;
      await saveIndex(index);
    },

    async rename(id, title) {
      assertSessionId(id);
      const value = normalizeTitle(title);
      const index = await loadIndex();
      const session = index.sessions.find((item) => item.id === id);
      if (!session) throw new Error(`Unknown session: ${id}`);
      session.title = value;
      await saveIndex(index);
      return structuredClone(session);
    },

    async bindComputer(id, workspaceId, computerRef) {
      assertSessionId(id);
      validateComputerBinding(workspaceId, computerRef);
      const index = await loadIndex();
      const session = index.sessions.find((item) => item.id === id);
      if (!session) throw new Error(`Unknown session: ${id}`);
      session.workspaceId = workspaceId;
      session.computerRef = structuredClone(computerRef);
      await saveIndex(index);
      return structuredClone(session);
    },

    async remove(id) {
      assertSessionId(id);
      const index = await loadIndex();
      const before = index.sessions.length;
      index.sessions = index.sessions.filter((item) => item.id !== id);
      if (index.sessions.length === before) throw new Error(`Unknown session: ${id}`);
      if (index.activeSessionId === id) {
        const next = index.sessions[0]?.id;
        if (next) index.activeSessionId = next;
        else delete index.activeSessionId;
      }
      await rm(snapshotPath(id), { force: true });
      await saveIndex(index);
    },

    async setActive(id) {
      const index = await loadIndex();
      if (id !== undefined) {
        assertSessionId(id);
        if (!index.sessions.some((item) => item.id === id)) throw new Error(`Unknown session: ${id}`);
      }
      if (id === undefined) delete index.activeSessionId;
      else index.activeSessionId = id;
      await saveIndex(index);
    },
  };
}
