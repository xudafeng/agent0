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

interface RegisteredTool {
  definition: ToolDefinition;
  execute(arguments_: Record<string, unknown>): unknown;
}

function requireNumbers(arguments_: Record<string, unknown>) {
  const { a, b } = arguments_;
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new Error('Tool requires numeric a and b arguments.');
  }
  return { a, b };
}

const registry: Record<string, RegisteredTool> = {
  add: {
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
    execute(arguments_) {
      const { a, b } = requireNumbers(arguments_);
      return a + b;
    },
  },
  subtract: {
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
    execute(arguments_) {
      const { a, b } = requireNumbers(arguments_);
      return a - b;
    },
  },
  multiply: {
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
    execute(arguments_) {
      const { a, b } = requireNumbers(arguments_);
      return a * b;
    },
  },
};

export const tools: ToolDefinition[] = Object.values(registry).map((tool) => tool.definition);

export function executeTool(toolCall: ToolCall): unknown {
  const tool = registry[toolCall.name];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolCall.name}`);
  }
  return tool.execute(toolCall.arguments);
}
