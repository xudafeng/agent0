import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const TRACE_PATH = 'data/traces.ndjson';

export type TraceEventType =
  | 'run_start'
  | 'model_result'
  | 'jev_decision'
  | 'tool_call'
  | 'tool_result'
  | 'final_answer'
  | 'run_error';

export interface TraceEvent {
  runId: string;
  timestamp: string;
  step?: number;
  type: TraceEventType;
  data?: Record<string, unknown>;
}

export interface TraceRecorder {
  runId: string;
  record(type: TraceEventType, data?: Record<string, unknown>, step?: number): Promise<void>;
}

export async function createTraceRecorder(onEvent?: (event: TraceEvent) => void): Promise<TraceRecorder> {
  await mkdir(dirname(TRACE_PATH), { recursive: true });
  const runId = randomUUID();

  return {
    runId,
    async record(type, data, step) {
      const event: TraceEvent = {
        runId,
        timestamp: new Date().toISOString(),
        ...(step === undefined ? {} : { step }),
        type,
        ...(data === undefined ? {} : { data }),
      };
      await appendFile(TRACE_PATH, `${JSON.stringify(event)}\n`, 'utf-8');
      onEvent?.(event);
    },
  };
}
