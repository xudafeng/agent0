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

export interface ToolApprovalRequest {
  toolCall: ToolCall;
  reason: string;
}

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
  signal?: AbortSignal,
) => Promise<boolean> | boolean;

export interface ToolExecutionContext {
  signal?: AbortSignal;
  requestApproval?: ToolApprovalHandler;
  onExecutionStart?: () => Promise<void> | void;
}

export type ToolPolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason: string };

export type ToolExecutionPolicy = (
  toolCall: ToolCall,
  context: ToolExecutionContext,
) => Promise<ToolPolicyDecision> | ToolPolicyDecision;

export interface ToolRetryPolicy {
  maxAttempts: number;
  delayMs?: number;
  shouldRetry(error: unknown): boolean;
}

export interface AgentTool {
  definition: ToolDefinition;
  executionMode?: 'parallel' | 'sequential';
  idempotency?: 'idempotent' | 'non-idempotent';
  retry?: ToolRetryPolicy;
  timeoutMs?: number;
  execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<unknown> | unknown;
}

export type ToolExecutor = (toolCall: ToolCall, context: ToolExecutionContext) => Promise<unknown> | unknown;

export function adaptToolDefinitions(
  definitions: ToolDefinition[],
  execute: ToolExecutor,
  executionMode: AgentTool['executionMode'] = 'parallel',
  timeoutMs?: number,
): AgentTool[] {
  return definitions.map((definition) => ({
    definition,
    executionMode,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    execute,
  }));
}

export class ToolExecutionTimeoutError extends Error {
  constructor(
    public readonly toolCall: ToolCall,
    public readonly timeoutMs: number,
  ) {
    super(`Tool execution timed out after ${timeoutMs} ms: ${toolCall.name}`);
    this.name = 'ToolExecutionTimeoutError';
  }
}

export class ToolExecutionDeniedError extends Error {
  constructor(
    public readonly toolCall: ToolCall,
    public readonly reason: string,
  ) {
    super(`Tool execution denied: ${reason}`);
    this.name = 'ToolExecutionDeniedError';
  }
}

export interface ToolRegistry {
  definitions: ToolDefinition[];
  has(name: string): boolean;
  executionMode(name: string): 'parallel' | 'sequential';
  execute(toolCall: ToolCall, context?: ToolExecutionContext): Promise<unknown>;
}

export function createToolRegistry(agentTools: AgentTool[], policy?: ToolExecutionPolicy): ToolRegistry {
  const registry = new Map<string, AgentTool>();

  for (const tool of agentTools) {
    const { name } = tool.definition;
    if (registry.has(name)) {
      throw new Error(`Duplicate tool: ${name}`);
    }
    if (tool.retry && tool.idempotency !== 'idempotent') {
      throw new Error(`Retry requires idempotent tool: ${name}`);
    }
    if (tool.retry && (!Number.isInteger(tool.retry.maxAttempts) || tool.retry.maxAttempts < 2 || tool.retry.maxAttempts > 5)) {
      throw new Error(`Invalid retry attempts for tool ${name}: ${tool.retry.maxAttempts}`);
    }
    if (tool.retry?.delayMs !== undefined && (!Number.isFinite(tool.retry.delayMs) || tool.retry.delayMs < 0 || tool.retry.delayMs > 30000)) {
      throw new Error(`Invalid retry delay for tool ${name}: ${tool.retry.delayMs}`);
    }
    registry.set(name, tool);
  }

  return {
    definitions: agentTools.map((tool) => tool.definition),
    has(name) {
      return registry.has(name);
    },
    executionMode(name) {
      return registry.get(name)?.executionMode ?? 'parallel';
    },
    async execute(toolCall, context = {}) {
      context.signal?.throwIfAborted();
      const tool = registry.get(toolCall.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${toolCall.name}`);
      }
      const decision = await policy?.(toolCall, context) ?? { action: 'allow' };
      if (decision.action === 'deny') {
        throw new ToolExecutionDeniedError(toolCall, decision.reason);
      }
      if (decision.action === 'ask') {
        if (!context.requestApproval) {
          throw new ToolExecutionDeniedError(toolCall, 'Approval required but no approval handler is available.');
        }
        const approved = await context.requestApproval({ toolCall, reason: decision.reason }, context.signal);
        if (!approved) {
          throw new ToolExecutionDeniedError(toolCall, 'Denied by user.');
        }
      }
      context.signal?.throwIfAborted();
      await context.onExecutionStart?.();

      const executeAttempt = async (): Promise<unknown> => {
        if (tool.timeoutMs === undefined) {
          return tool.execute(toolCall, context);
        }
        if (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0) {
          throw new Error(`Invalid timeout for tool ${toolCall.name}: ${tool.timeoutMs}`);
        }

        const timeoutController = new AbortController();
        const timeout = setTimeout(() => {
          timeoutController.abort(new ToolExecutionTimeoutError(toolCall, tool.timeoutMs!));
        }, tool.timeoutMs);
        const signal = context.signal
          ? AbortSignal.any([context.signal, timeoutController.signal])
          : timeoutController.signal;

        try {
          return await Promise.race([
            Promise.resolve(tool.execute(toolCall, { ...context, signal })),
            new Promise<never>((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      };

      const maxAttempts = tool.retry?.maxAttempts ?? 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        context.signal?.throwIfAborted();
        try {
          return await executeAttempt();
        } catch (error) {
          context.signal?.throwIfAborted();
          if (!tool.retry || attempt >= maxAttempts || !tool.retry.shouldRetry(error)) {
            throw error;
          }
          const delayMs = tool.retry.delayMs ?? 0;
          if (delayMs > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delayMs);
              context.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(context.signal!.reason);
              }, { once: true });
            });
          }
        }
      }

      throw new Error('Unreachable retry state.');
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
