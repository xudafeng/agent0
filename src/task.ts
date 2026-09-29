import type { ToolCall, ToolDefinition } from './tools.js';

export type TaskStepStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskStep {
  description: string;
  status: TaskStepStatus;
}

export interface TaskState {
  goal: string;
  steps: TaskStep[];
}

export interface TaskRuntime {
  tools: ToolDefinition[];
  hasTool(name: string): boolean;
  callTool(toolCall: ToolCall): unknown;
  getState(): TaskState | undefined;
  restore(next: TaskState | undefined): void;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  return value.map((item) => item.trim());
}

export function createTaskRuntime(): TaskRuntime {
  let state: TaskState | undefined;

  const tools: ToolDefinition[] = [
    {
      name: 'set_plan',
      description: 'Create or replace the explicit plan for the current multi-step task.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The task goal.' },
          steps: {
            type: 'array',
            description: 'Ordered steps required to complete the task.',
            items: { type: 'string' },
          },
        },
        required: ['goal', 'steps'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_step',
      description: 'Update the status of one step in the current plan.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Zero-based step index.' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
          },
        },
        required: ['index', 'status'],
        additionalProperties: false,
      },
    },
  ];

  return {
    tools,
    hasTool(name) {
      return name === 'set_plan' || name === 'update_step';
    },
    callTool(toolCall) {
      if (toolCall.name === 'set_plan') {
        const { goal, steps } = toolCall.arguments;
        if (typeof goal !== 'string' || !goal.trim()) {
          throw new Error('goal must be a non-empty string.');
        }

        const descriptions = requireStringArray(steps, 'steps');
        state = {
          goal: goal.trim(),
          steps: descriptions.map((description, index) => ({
            description,
            status: index === 0 ? 'in_progress' : 'pending',
          })),
        };
        return state;
      }

      if (toolCall.name === 'update_step') {
        if (!state) {
          throw new Error('No active task plan.');
        }

        const { index, status } = toolCall.arguments;
        if (!Number.isInteger(index) || typeof index !== 'number') {
          throw new Error('index must be an integer.');
        }
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          throw new Error('Invalid step status.');
        }
        if (index < 0 || index >= state.steps.length) {
          throw new Error(`Step index out of range: ${index}`);
        }

        const step = state.steps[index];
        if (!step) throw new Error(`Step index out of range: ${index}`);
        state.steps[index] = { ...step, status };
        return state;
      }

      throw new Error(`Unknown task tool: ${toolCall.name}`);
    },
    getState() {
      return state;
    },
    restore(next) {
      state = next ? structuredClone(next) : undefined;
    },
  };
}

export function formatTaskState(state: TaskState | undefined): string {
  if (!state) {
    return '';
  }

  const steps = state.steps
    .map((step, index) => `${index}. [${step.status}] ${step.description}`)
    .join('\n');

  return `Goal: ${state.goal}\nSteps:\n${steps}`;
}
