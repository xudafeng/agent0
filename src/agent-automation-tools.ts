import { z } from 'zod';
import type { AgentAutomationStore } from './agent-automation.js';
import type { AgentTool } from './tools.js';

const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(32000),
  cwd: z.string().trim().min(1).max(4000),
  skillName: z.string().trim().min(1).max(200).optional(),
  skillRoots: z.array(z.string().trim().min(1).max(4000)).max(20).optional(),
  policy: z.enum(['read-only', 'trusted-workspace']).optional(),
  repeatEveryMs: z.number().finite().positive().optional(),
  cronExpression: z.string().trim().min(1).max(500).optional(),
  timeZone: z.string().trim().min(1).max(200).optional(),
  maxRunMs: z.number().finite().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
}).strict();

const idSchema = z.object({
  automationId: z.string().trim().min(1),
}).strict();

export function createAgentAutomationTools(store: AgentAutomationStore): AgentTool[] {
  return [
    {
      definition: {
        name: 'schedule_agent_run',
        description: 'Create a durable recurring headless Agent automation. Use either repeatEveryMs or cronExpression + timeZone.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string' },
            cwd: { type: 'string', description: 'Trusted local working directory for the headless AgentRun.' },
            skillName: { type: 'string' },
            skillRoots: { type: 'array', items: { type: 'string' } },
            policy: { type: 'string', enum: ['read-only', 'trusted-workspace'] },
            repeatEveryMs: { type: 'number', description: 'Positive interval in milliseconds.' },
            cronExpression: { type: 'string', description: 'Cron expression for recurring execution.' },
            timeZone: { type: 'string', description: 'IANA timezone required with cronExpression.' },
            maxRunMs: { type: 'number', description: 'Maximum duration for one AgentRun in milliseconds. Defaults to 6 hours.' },
          },
          required: ['prompt', 'cwd'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const parsed = scheduleSchema.parse(toolCall.arguments);
        return store.create({
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
          prompt: parsed.prompt,
          cwd: parsed.cwd,
          ...(parsed.skillName === undefined ? {} : { skillName: parsed.skillName }),
          ...(parsed.skillRoots === undefined ? {} : { skillRoots: parsed.skillRoots }),
          ...(parsed.policy === undefined ? {} : { policy: parsed.policy }),
          ...(parsed.repeatEveryMs === undefined ? {} : { repeatEveryMs: parsed.repeatEveryMs }),
          ...(parsed.cronExpression === undefined ? {} : { cronExpression: parsed.cronExpression }),
          ...(parsed.timeZone === undefined ? {} : { timeZone: parsed.timeZone }),
          ...(parsed.maxRunMs === undefined ? {} : { maxRunMs: parsed.maxRunMs }),
        });
      },
    },
    {
      definition: {
        name: 'agent_automation_list',
        description: 'List durable scheduled Agent automations and their next/last run state.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute() {
        return store.list();
      },
    },
    {
      definition: {
        name: 'agent_automation_status',
        description: 'Read one scheduled Agent automation.',
        parameters: {
          type: 'object',
          properties: { automationId: { type: 'string' } },
          required: ['automationId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall) {
        return store.get(idSchema.parse(toolCall.arguments).automationId);
      },
    },
    {
      definition: {
        name: 'agent_automation_cancel',
        description: 'Disable a scheduled Agent automation.',
        parameters: {
          type: 'object',
          properties: { automationId: { type: 'string' } },
          required: ['automationId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        return store.cancel(idSchema.parse(toolCall.arguments).automationId);
      },
    },
    {
      definition: {
        name: 'agent_automation_enable',
        description: 'Re-enable a disabled Agent automation and schedule its next future run.',
        parameters: {
          type: 'object',
          properties: { automationId: { type: 'string' } },
          required: ['automationId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        return store.enable(idSchema.parse(toolCall.arguments).automationId);
      },
    },
  ];
}
