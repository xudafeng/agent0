import { z } from 'zod';
import type { Provider } from './provider.js';
import { formatMission, type MissionStore } from './autonomy.js';
import type { ArtifactStore } from './artifact.js';
import type { AgentTool } from './tools.js';

const createSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(1000),
    dependsOn: z.array(z.number().int().nonnegative()).optional(),
  }).strict()).min(1).max(50),
}).strict();

const missionIdSchema = z.object({
  missionId: z.string().trim().min(1),
}).strict();

const updateTaskSchema = z.object({
  missionId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional(),
  result: z.string().trim().min(1).max(8000).optional(),
}).strict();

const delegateSchema = z.object({
  missionId: z.string().trim().min(1),
  taskIds: z.array(z.string().trim().min(1)).min(1).max(4),
}).strict();

const artifactSchema = z.object({
  missionId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(500),
  kind: z.enum(['markdown', 'text', 'json']).optional(),
  content: z.string().trim().min(1).max(100000),
}).strict();

const artifactIdSchema = z.object({
  artifactId: z.string().trim().min(1),
}).strict();

const handoffSchema = z.object({
  missionId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(2000),
  question: z.string().trim().min(1).max(4000),
}).strict();

const evaluationSchema = z.object({
  missionId: z.string().trim().min(1),
  criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
}).strict();

function parseEvaluation(text: string): { score: number; summary: string } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Evaluator returned no JSON object.');
  const parsed = z.object({
    score: z.number().min(0).max(1),
    summary: z.string().trim().min(1).max(4000),
  }).parse(JSON.parse(match[0]));
  return parsed;
}

export function createAutonomyTools(
  missions: MissionStore,
  artifacts: ArtifactStore,
  provider: Provider,
): AgentTool[] {
  return [
    {
      definition: {
        name: 'autonomy_create_mission',
        description: 'Create a durable long-horizon mission with a dependency graph of tasks.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'Mission goal.' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  dependsOn: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Zero-based indexes of prerequisite tasks.',
                  },
                },
                required: ['title'],
                additionalProperties: false,
              },
            },
          },
          required: ['goal', 'tasks'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const parsed = createSchema.parse(toolCall.arguments);
        return missions.create(parsed.goal, parsed.tasks);
      },
    },
    {
      definition: {
        name: 'autonomy_list_missions',
        description: 'List durable autonomous missions.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute() {
        return missions.list();
      },
    },
    {
      definition: {
        name: 'autonomy_mission_state',
        description: 'Read one durable mission including task graph, artifacts, handoff, and evaluation.',
        parameters: {
          type: 'object',
          properties: { missionId: { type: 'string' } },
          required: ['missionId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall) {
        return missions.get(missionIdSchema.parse(toolCall.arguments).missionId);
      },
    },
    {
      definition: {
        name: 'autonomy_update_task',
        description: 'Advance, complete, or block a mission task. Dependency constraints are enforced.',
        parameters: {
          type: 'object',
          properties: {
            missionId: { type: 'string' },
            taskId: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'blocked'],
            },
            result: { type: 'string' },
          },
          required: ['missionId', 'taskId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const parsed = updateTaskSchema.parse(toolCall.arguments);
        return missions.updateTask(parsed.missionId, parsed.taskId, {
          ...(parsed.status === undefined ? {} : { status: parsed.status }),
          ...(parsed.result === undefined ? {} : { result: parsed.result }),
        });
      },
    },
    {
      definition: {
        name: 'autonomy_delegate_parallel',
        description: 'Run up to four ready mission tasks in isolated subagents in parallel and mark successful tasks complete.',
        parameters: {
          type: 'object',
          properties: {
            missionId: { type: 'string' },
            taskIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 4,
            },
          },
          required: ['missionId', 'taskIds'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall, context) {
        const parsed = delegateSchema.parse(toolCall.arguments);
        const mission = await missions.get(parsed.missionId);
        const selected = parsed.taskIds.map((id) => {
          const task = mission.tasks.find((item) => item.id === id);
          if (!task) throw new Error(`Mission task not found: ${id}`);
          if (task.status !== 'in_progress' && task.status !== 'pending') {
            throw new Error(`Mission task is not runnable: ${id}`);
          }
          const unmet = task.dependsOn.filter((dependency) =>
            mission.tasks.find((item) => item.id === dependency)?.status !== 'completed'
          );
          if (unmet.length) throw new Error(`Task dependencies are not complete: ${unmet.join(', ')}`);
          return task;
        });

        const results = await Promise.all(selected.map(async (task) => {
          context.signal?.throwIfAborted();
          const result = await provider.generate([
            {
              role: 'system',
              content: 'You are an isolated execution subagent. Complete only the assigned mission task. Return a concise, concrete result for the parent agent. Do not invent completion if blocked.',
            },
            {
              role: 'user',
              content: `Mission goal: ${mission.goal}\nTask: ${task.title}`,
            },
          ], undefined, context.signal);

          if (!result.text) throw new Error(`Subagent returned no text for task: ${task.id}`);
          return {
            taskId: task.id,
            text: result.text,
            model: result.model,
            usage: result.usage,
          };
        }));

        // Subagents execute in parallel, but durable mission writes are committed
        // sequentially to avoid lost updates on the shared mission document.
        for (const result of results) {
          await missions.updateTask(parsed.missionId, result.taskId, {
            status: 'completed',
            result: result.text,
          });
        }

        return results;
      },
    },
    {
      definition: {
        name: 'artifact_create',
        description: 'Create a durable artifact and optionally attach it to a mission.',
        parameters: {
          type: 'object',
          properties: {
            missionId: { type: 'string' },
            title: { type: 'string' },
            kind: { type: 'string', enum: ['markdown', 'text', 'json'] },
            content: { type: 'string' },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall) {
        const parsed = artifactSchema.parse(toolCall.arguments);
        const artifact = await artifacts.create({
          title: parsed.title,
          ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
          content: parsed.content,
        });
        if (parsed.missionId) await missions.attachArtifact(parsed.missionId, artifact.id);
        return artifact;
      },
    },
    {
      definition: {
        name: 'artifact_list',
        description: 'List durable agent artifacts.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute() {
        return artifacts.list();
      },
    },
    {
      definition: {
        name: 'artifact_read',
        description: 'Read a durable agent artifact by ID.',
        parameters: {
          type: 'object',
          properties: { artifactId: { type: 'string' } },
          required: ['artifactId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall) {
        return artifacts.read(artifactIdSchema.parse(toolCall.arguments).artifactId);
      },
    },
    {
      definition: {
        name: 'autonomy_request_handoff',
        description: 'Explicitly pause a mission and request human judgment, authorization, or missing information.',
        parameters: {
          type: 'object',
          properties: {
            missionId: { type: 'string' },
            reason: { type: 'string' },
            question: { type: 'string' },
          },
          required: ['missionId', 'reason', 'question'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall) {
        const parsed = handoffSchema.parse(toolCall.arguments);
        return missions.requestHandoff(parsed.missionId, parsed.reason, parsed.question);
      },
    },
    {
      definition: {
        name: 'autonomy_evaluate',
        description: 'Run an isolated evaluator over a mission using explicit criteria and persist the resulting score.',
        parameters: {
          type: 'object',
          properties: {
            missionId: { type: 'string' },
            criteria: { type: 'array', items: { type: 'string' } },
          },
          required: ['missionId', 'criteria'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall, context) {
        const parsed = evaluationSchema.parse(toolCall.arguments);
        const mission = await missions.get(parsed.missionId);
        const result = await provider.generate([
          {
            role: 'system',
            content: 'You are an independent evaluator. Assess the mission result against the criteria. Return JSON only: {"score": number between 0 and 1, "summary": string}.',
          },
          {
            role: 'user',
            content: `${formatMission(mission)}\n\nCriteria:\n${parsed.criteria.map((item) => `- ${item}`).join('\n')}`,
          },
        ], undefined, context.signal);
        if (!result.text) throw new Error('Evaluator returned no text.');
        const evaluation = parseEvaluation(result.text);
        return missions.setEvaluation(parsed.missionId, {
          score: evaluation.score,
          summary: evaluation.summary,
          criteria: parsed.criteria,
        });
      },
    },
  ];
}
