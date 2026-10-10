import { z } from 'zod';
import type { PersonalStateStore } from './personal-state.js';
import type { AgentTool } from './tools.js';

const idSchema = z.string().trim().min(1);

export function createPersonalStateTools(store: PersonalStateStore): AgentTool[] {
  return [
    {
      definition: {
        name: 'personal_state',
        description: 'Read the current persistent personal agent state including daily focus, goals, active tasks, and notes.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute() {
        return store.get();
      },
    },
    {
      definition: {
        name: 'personal_set_focus',
        description: 'Set or clear the current daily focus.',
        parameters: {
          type: 'object',
          properties: { focus: { type: 'string', description: 'Daily focus. Empty string clears it.' } },
          required: ['focus'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const focus = z.string().max(1000).parse(toolCall.arguments.focus);
        return store.setDailyFocus(focus);
      },
    },
    {
      definition: {
        name: 'personal_add_goal',
        description: 'Add a persistent personal goal.',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string', description: 'Goal title.' } },
          required: ['title'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        return store.addGoal(z.string().trim().min(1).max(500).parse(toolCall.arguments.title));
      },
    },
    {
      definition: {
        name: 'personal_remove_goal',
        description: 'Remove a persistent personal goal by ID. Linked tasks remain but become unlinked.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Goal ID.' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall) {
        const id = idSchema.parse(toolCall.arguments.id);
        await store.removeGoal(id);
        return { id, removed: true };
      },
    },
    {
      definition: {
        name: 'personal_add_task',
        description: 'Add a persistent task, optionally linked to a personal goal.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title.' },
            goalId: { type: 'string', description: 'Optional goal ID.' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const parsed = z.object({
          title: z.string().trim().min(1).max(1000),
          goalId: z.string().trim().min(1).optional(),
        }).strict().parse(toolCall.arguments);
        return store.addTask(parsed.title, parsed.goalId);
      },
    },
    {
      definition: {
        name: 'personal_update_task',
        description: 'Update a persistent task title, status, or goal link.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Task ID.' },
            title: { type: 'string', description: 'Optional replacement title.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            goalId: { type: ['string', 'null'], description: 'Optional goal ID, or null to unlink.' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const parsed = z.object({
          id: z.string().trim().min(1),
          title: z.string().trim().min(1).max(1000).optional(),
          status: z.enum(['pending', 'in_progress', 'completed']).optional(),
          goalId: z.string().trim().min(1).nullable().optional(),
        }).strict().parse(toolCall.arguments);
        return store.updateTask(parsed.id, {
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
          ...(parsed.status === undefined ? {} : { status: parsed.status }),
          ...(parsed.goalId === undefined ? {} : { goalId: parsed.goalId }),
        });
      },
    },
    {
      definition: {
        name: 'personal_add_note',
        description: 'Add a short note to today’s persistent personal working state.',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string', description: 'Daily working note.' } },
          required: ['content'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        return store.addNote(z.string().trim().min(1).max(2000).parse(toolCall.arguments.content));
      },
    },
    {
      definition: {
        name: 'personal_journal',
        description: 'Append a durable Markdown entry to today’s personal journal.',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string', description: 'Journal entry content.' } },
          required: ['content'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        return store.appendDailyJournal(z.string().trim().min(1).max(10000).parse(toolCall.arguments.content));
      },
    },
  ];
}
