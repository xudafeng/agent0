import { z } from 'zod';
import type { DurableScheduler } from './scheduler.js';
import type { AgentTool } from './tools.js';

const scheduleCreateSchema = z.object({
  runAt: z.string().trim().min(1),
  repeatEveryMs: z.number().finite().positive().optional(),
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();

const scheduleIdSchema = z.object({
  scheduleId: z.string().trim().min(1),
}).strict();

export function createSchedulerTools(scheduler: DurableScheduler): AgentTool[] {
  return [
    {
      definition: {
        name: 'schedule_create',
        description: 'Schedule a durable background job at a future ISO date-time, optionally repeating at a fixed interval.',
        parameters: {
          type: 'object',
          properties: {
            runAt: { type: 'string', description: 'Future ISO date-time when the job should start.' },
            repeatEveryMs: { type: 'number', description: 'Optional positive interval in milliseconds for recurring schedules.' },
            command: { type: 'string', description: 'Executable to start.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
            cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Optional environment variables for the scheduled job.',
            },
          },
          required: ['runAt', 'command'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const parsed = scheduleCreateSchema.parse(toolCall.arguments);
        return scheduler.schedule({
          command: parsed.command,
          ...(parsed.args === undefined ? {} : { args: parsed.args }),
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
          ...(parsed.env === undefined ? {} : { env: parsed.env }),
        }, parsed.runAt, parsed.repeatEveryMs);
      },
    },
    {
      definition: {
        name: 'schedule_status',
        description: 'Get one durable schedule by scheduleId.',
        parameters: {
          type: 'object',
          properties: {
            scheduleId: { type: 'string', description: 'Stable schedule ID returned by schedule_create.' },
          },
          required: ['scheduleId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall) {
        return scheduler.get(scheduleIdSchema.parse(toolCall.arguments).scheduleId);
      },
    },
    {
      definition: {
        name: 'schedule_list',
        description: 'List durable schedules for the current computer workspace.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute() {
        return scheduler.list();
      },
    },
    {
      definition: {
        name: 'schedule_cancel',
        description: 'Cancel a pending durable schedule before it starts.',
        parameters: {
          type: 'object',
          properties: {
            scheduleId: { type: 'string', description: 'Stable schedule ID returned by schedule_create.' },
          },
          required: ['scheduleId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        return scheduler.cancel(scheduleIdSchema.parse(toolCall.arguments).scheduleId);
      },
    },
  ];
}
