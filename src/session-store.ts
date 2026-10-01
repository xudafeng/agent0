import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

export interface SessionStore {
  load(): Promise<SessionSnapshot | undefined>;
  save(snapshot: SessionSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export function createFileSessionStore(path = 'data/session.json'): SessionStore {
  return {
    async load() {
      try {
        const content = await readFile(path, 'utf8');
        const parsed: unknown = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid session snapshot.');
        const snapshot = parsed as Partial<SessionSnapshot>;
        if (snapshot.version !== 1 || !Array.isArray(snapshot.history) || !snapshot.runtime || typeof snapshot.updatedAt !== 'string') {
          throw new Error('Invalid session snapshot.');
        }
        return snapshot as SessionSnapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },

    async save(snapshot) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
    },

    async clear() {
      await rm(path, { force: true });
    },
  };
}
