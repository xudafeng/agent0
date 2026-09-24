import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Message } from './provider.js';
import type { TaskState } from './task.js';

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface RunCheckpoint {
  runId: string;
  status: RunStatus;
  prompt: string;
  step: number;
  messages: Message[];
  task?: TaskState;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  load(runId: string): Promise<RunCheckpoint | undefined>;
}

export function createFileRunStore(root = 'data/runs'): RunStore {
  const pathFor = (runId: string) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run ID.');
    return join(root, `${runId}.json`);
  };

  return {
    async save(checkpoint) {
      const path = pathFor(checkpoint.runId);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
    },

    async load(runId) {
      try {
        const content = await readFile(pathFor(runId), 'utf8');
        return JSON.parse(content) as RunCheckpoint;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
  };
}
