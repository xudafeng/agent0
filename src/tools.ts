export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export interface AgentTool {
  definition: ToolDefinition;
  execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<unknown> | unknown;
}

export type ToolExecutor = (toolCall: ToolCall, context: ToolExecutionContext) => Promise<unknown> | unknown;

export function adaptToolDefinitions(definitions: ToolDefinition[], execute: ToolExecutor): AgentTool[] {
  return definitions.map((definition) => ({ definition, execute }));
}

export interface ToolRegistry {
  definitions: ToolDefinition[];
  has(name: string): boolean;
  execute(toolCall: ToolCall, context?: ToolExecutionContext): Promise<unknown>;
}

export function createToolRegistry(agentTools: AgentTool[]): ToolRegistry {
  const registry = new Map<string, AgentTool>();

  for (const tool of agentTools) {
    const { name } = tool.definition;
    if (registry.has(name)) {
      throw new Error(`Duplicate tool: ${name}`);
    }
    registry.set(name, tool);
  }

  return {
    definitions: agentTools.map((tool) => tool.definition),
    has(name) {
      return registry.has(name);
    },
    async execute(toolCall, context = {}) {
      context.signal?.throwIfAborted();
      const tool = registry.get(toolCall.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${toolCall.name}`);
      }
      return tool.execute(toolCall, context);
    },
  };
}

function requireNumbers(arguments_: Record<string, unknown>) {
  const { a, b } = arguments_;
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new Error('Tool requires numeric a and b arguments.');
  }
  return { a, b };
}

export const localAgentTools: AgentTool[] = [
  {
    definition: {
      name: 'add',
      description: 'Add two numbers.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'The first number.' },
          b: { type: 'number', description: 'The second number.' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
    execute(toolCall) {
      const { a, b } = requireNumbers(toolCall.arguments);
      return a + b;
    },
  },
  {
    definition: {
      name: 'subtract',
      description: 'Subtract the second number from the first number.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'The first number.' },
          b: { type: 'number', description: 'The number to subtract.' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
    execute(toolCall) {
      const { a, b } = requireNumbers(toolCall.arguments);
      return a - b;
    },
  },
  {
    definition: {
      name: 'multiply',
      description: 'Multiply two numbers.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'The first number.' },
          b: { type: 'number', description: 'The second number.' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
    execute(toolCall) {
      const { a, b } = requireNumbers(toolCall.arguments);
      return a * b;
    },
  },
];

export const tools: ToolDefinition[] = localAgentTools.map((tool) => tool.definition);

const localRegistry = createToolRegistry(localAgentTools);

export function executeTool(toolCall: ToolCall): Promise<unknown> {
  return localRegistry.execute(toolCall);
}
