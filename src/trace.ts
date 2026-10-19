import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentEvent } from './events.js';

const TRACE_PATH = 'data/traces.ndjson';

export interface TraceRecorder {
  record(event: AgentEvent): Promise<void>;
}

export async function createTraceRecorder(path = TRACE_PATH): Promise<TraceRecorder> {
  await mkdir(dirname(path), { recursive: true });

  return {
    async record(event) {
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf-8');
    },
  };
}
