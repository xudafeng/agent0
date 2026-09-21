import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentEvent } from './events.js';

const TRACE_PATH = 'data/traces.ndjson';

export interface TraceRecorder {
  record(event: AgentEvent): Promise<void>;
}

export async function createTraceRecorder(): Promise<TraceRecorder> {
  await mkdir(dirname(TRACE_PATH), { recursive: true });

  return {
    async record(event) {
      await appendFile(TRACE_PATH, `${JSON.stringify(event)}\n`, 'utf-8');
    },
  };
}
