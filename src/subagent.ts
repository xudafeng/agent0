import type { Provider } from './provider.js';
import type { ToolCall, ToolDefinition } from './tools.js';

export interface SubagentRuntime {
  tools: ToolDefinition[];
  hasTool(name: string): boolean;
  callTool(toolCall: ToolCall): Promise<unknown>;
}

export function createSubagentRuntime(provider: Provider): SubagentRuntime {
  const tools: ToolDefinition[] = [
    {
      name: 'delegate_task',
      description: 'Delegate one focused subtask to an isolated subagent and return its result.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A self-contained subtask with enough context for the subagent to complete it independently.',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  ];

  return {
    tools,
    hasTool(name) {
      return name === 'delegate_task';
    },
    async callTool(toolCall) {
      if (toolCall.name !== 'delegate_task') {
        throw new Error(`Unknown subagent tool: ${toolCall.name}`);
      }

      const { task } = toolCall.arguments;
      if (typeof task !== 'string' || !task.trim()) {
        throw new Error('task must be a non-empty string.');
      }

      const result = await provider.generate([
        {
          role: 'system',
          content: 'You are a focused subagent. Complete only the delegated subtask. Return a concise result that the parent agent can use.',
        },
        { role: 'user', content: task.trim() },
      ]);

      if (!result.text) {
        throw new Error('Subagent returned no text result.');
      }

      return {
        text: result.text,
        model: result.model,
        usage: result.usage,
      };
    },
  };
}
