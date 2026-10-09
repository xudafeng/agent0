import { z } from 'zod';
import type { Computer } from './computer.js';
import { getDurableJobStatus, readDurableJobOutput, startDurableJob } from './job.js';
import type { AgentTool } from './tools.js';

const startJobSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();

const jobSchema = z.object({
  jobId: z.string().trim().min(1),
}).strict();

export function createJobTools(computer: Computer): AgentTool[] {
  return [
    {
      definition: {
        name: 'job_start',
        description: 'Start a durable background job on the current computer. Returns a stable jobId that can be checked after later turns or computer reconnects.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Executable to start.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
            cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Optional environment variables for the job.',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall, context) {
        const parsed = startJobSchema.parse(toolCall.arguments);
        return startDurableJob(computer, {
          command: parsed.command,
          ...(parsed.args === undefined ? {} : { args: parsed.args }),
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
          ...(parsed.env === undefined ? {} : { env: parsed.env }),
        }, context.signal);
      },
    },
    {
      definition: {
        name: 'job_status',
        description: 'Get the durable state of a background job by jobId.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Stable job ID returned by job_start.' },
          },
          required: ['jobId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall, context) {
        const { jobId } = jobSchema.parse(toolCall.arguments);
        return getDurableJobStatus(computer, jobId, context.signal);
      },
    },
    {
      definition: {
        name: 'job_output',
        description: 'Read captured stdout and stderr for a durable background job.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Stable job ID returned by job_start.' },
          },
          required: ['jobId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall, context) {
        const { jobId } = jobSchema.parse(toolCall.arguments);
        return readDurableJobOutput(computer, jobId, context.signal);
      },
    },
  ];
}
