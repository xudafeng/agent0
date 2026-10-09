import { z } from 'zod';
import {
  MEMORY_SCOPES,
  type MemoryScope,
  type MemoryStore,
} from './memory.js';
import type { AgentTool } from './tools.js';

const scopeSchema = z.enum(MEMORY_SCOPES);

const rememberSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  scope: scopeSchema.optional(),
}).strict();

const searchSchema = z.object({
  query: z.string(),
  scope: scopeSchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
}).strict();

const updateSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1).max(4000),
  scope: scopeSchema.optional(),
}).strict();

const forgetSchema = z.object({
  id: z.string().trim().min(1),
}).strict();

export function createMemoryTools(
  store: MemoryStore,
  onChange?: () => Promise<void> | void,
): AgentTool[] {
  return [
    {
      definition: {
        name: 'memory_remember',
        description: 'Save durable information for future conversations. Use the narrowest appropriate memory scope.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Concise durable fact or context to remember.' },
            scope: {
              type: 'string',
              enum: [...MEMORY_SCOPES],
              description: 'Memory scope: profile, preferences, projects, working, or general.',
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall) {
        const parsed = rememberSchema.parse(toolCall.arguments);
        const entry = await store.remember(parsed.content, parsed.scope);
        await onChange?.();
        return entry;
      },
    },
    {
      definition: {
        name: 'memory_search',
        description: 'Search durable memory for information relevant to the current task or question.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query. Empty query returns recent memory.' },
            scope: {
              type: 'string',
              enum: [...MEMORY_SCOPES],
              description: 'Optional memory scope filter.',
            },
            limit: { type: 'number', description: 'Maximum number of memory entries to return.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall) {
        const parsed = searchSchema.parse(toolCall.arguments);
        return store.search(parsed.query, {
          ...(parsed.scope === undefined ? {} : { scopes: [parsed.scope as MemoryScope] }),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        });
      },
    },
    {
      definition: {
        name: 'memory_list',
        description: 'List durable memory entries, optionally filtered by scope.',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: [...MEMORY_SCOPES],
              description: 'Optional memory scope filter.',
            },
          },
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall) {
        const scope = scopeSchema.optional().parse(toolCall.arguments.scope);
        return store.list(scope);
      },
    },
    {
      definition: {
        name: 'memory_update',
        description: 'Update an existing durable memory entry by stable memory ID.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable memory ID.' },
            content: { type: 'string', description: 'Replacement memory content.' },
            scope: {
              type: 'string',
              enum: [...MEMORY_SCOPES],
              description: 'Optional replacement scope.',
            },
          },
          required: ['id', 'content'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall) {
        const parsed = updateSchema.parse(toolCall.arguments);
        const entry = await store.update(parsed.id, parsed.content, parsed.scope);
        await onChange?.();
        return entry;
      },
    },
    {
      definition: {
        name: 'memory_forget',
        description: 'Delete a durable memory entry by stable memory ID.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable memory ID.' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall) {
        const { id } = forgetSchema.parse(toolCall.arguments);
        await store.forget(id);
        await onChange?.();
        return { id, forgotten: true };
      },
    },
  ];
}
