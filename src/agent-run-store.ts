import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type AgentRunTrigger = 'manual' | 'scheduled';
export type AgentRunStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface AgentRunRecord {
  version: 1;
  agentRunId: string;
  trigger: AgentRunTrigger;
  status: AgentRunStatus;
  prompt: string;
  sessionId: string;
  cwd?: string;
  skillName?: string;
  skillRoots: string[];
  policy: 'read-only' | 'trusted-workspace';
  runtimeRunId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentRunStore {
  create(input: Omit<AgentRunRecord, 'version' | 'agentRunId' | 'createdAt' | 'updatedAt'>): Promise<AgentRunRecord>;
  save(record: AgentRunRecord): Promise<void>;
  load(agentRunId: string): Promise<AgentRunRecord | undefined>;
  list(): Promise<AgentRunRecord[]>;
}

interface AgentRunIndex {
  version: 1;
  runIds: string[];
}

function assertId(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid agent run ID.');
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export function createFileAgentRunStore(root = 'data/agent-runs'): AgentRunStore {
  const indexPath = join(root, 'index.json');
  const pathFor = (id: string) => {
    assertId(id);
    return join(root, `${id}.json`);
  };

  const readIndex = async (): Promise<AgentRunIndex> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid agent run index.');
      const index = parsed as Partial<AgentRunIndex>;
      if (index.version !== 1 || !Array.isArray(index.runIds) ||
          index.runIds.some((id) => typeof id !== 'string')) {
        throw new Error('Invalid agent run index.');
      }
      return index as AgentRunIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runIds: [] };
      throw error;
    }
  };

  return {
    async create(input) {
      const now = new Date().toISOString();
      const record: AgentRunRecord = {
        version: 1,
        agentRunId: randomUUID(),
        ...structuredClone(input),
        createdAt: now,
        updatedAt: now,
      };
      const index = await readIndex();
      index.runIds.unshift(record.agentRunId);
      await Promise.all([
        atomicWrite(pathFor(record.agentRunId), record),
        atomicWrite(indexPath, index),
      ]);
      return structuredClone(record);
    },

    async save(record) {
      assertId(record.agentRunId);
      await atomicWrite(pathFor(record.agentRunId), {
        ...record,
        updatedAt: new Date().toISOString(),
      });
    },

    async load(agentRunId) {
      try {
        const parsed = JSON.parse(await readFile(pathFor(agentRunId), 'utf8')) as AgentRunRecord;
        if (parsed.version !== 1 || parsed.agentRunId !== agentRunId) {
          throw new Error('Invalid agent run record.');
        }
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },

    async list() {
      const index = await readIndex();
      const records = await Promise.all(index.runIds.map((id) => this.load(id)));
      return records.filter((record): record is AgentRunRecord => record !== undefined);
    },
  };
}
