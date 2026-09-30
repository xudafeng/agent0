import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolCall } from './tools.js';

export type ToolIdempotency = 'idempotent' | 'non-idempotent' | 'unknown';
export type ToolExecutionStatus = 'started' | 'completed';

export interface ToolExecutionRecord {
  executionId: string;
  runId: string;
  step: number;
  toolIndex: number;
  toolCall: ToolCall;
  idempotency: ToolIdempotency;
  status: ToolExecutionStatus;
  result?: string;
  isError?: boolean;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
}

export interface ToolExecutionLedger {
  load(runId: string, executionId: string): Promise<ToolExecutionRecord | undefined>;
  save(record: ToolExecutionRecord): Promise<void>;
}

function assertId(value: string, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid ${name}.`);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Tool arguments must be JSON-serializable.');
  return encoded;
}

export function createToolExecutionId(
  runId: string,
  step: number,
  toolIndex: number,
  toolCall: ToolCall,
): string {
  const input = [runId, step, toolIndex, toolCall.name, canonicalize(toolCall.arguments)].join('\n');
  return createHash('sha256').update(input).digest('hex');
}

export function createFileToolExecutionLedger(root = 'data/executions'): ToolExecutionLedger {
  const pathFor = (runId: string, executionId: string) => {
    assertId(runId, 'run ID');
    assertId(executionId, 'execution ID');
    return join(root, runId, `${executionId}.json`);
  };

  return {
    async load(runId, executionId) {
      try {
        const content = await readFile(pathFor(runId, executionId), 'utf8');
        return JSON.parse(content) as ToolExecutionRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },

    async save(record) {
      const path = pathFor(record.runId, record.executionId);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
    },
  };
}


export class ToolExecutionUncertainError extends Error {
  constructor(public readonly record: ToolExecutionRecord) {
    super(`Tool execution status is uncertain: ${record.toolCall.name} (${record.executionId})`);
    this.name = 'ToolExecutionUncertainError';
  }
}
