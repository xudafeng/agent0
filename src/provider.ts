import OpenAI from 'openai';
import type { ToolCall, ToolDefinition } from './tools.js';

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; toolCall: ToolCall }
  | { role: 'tool'; toolCallId: string; content: string };

export interface GenerationResult {
  text?: string | undefined;
  toolCall?: ToolCall | undefined;
  id: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | undefined;
}

export interface Provider {
  generate(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<GenerationResult>;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function parseToolArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function toOpenAIInput(messages: Message[]) {
  return messages.map((message) => {
    if (message.role === 'system' || message.role === 'user' || ('content' in message && message.role === 'assistant')) {
      return { role: message.role, content: message.content } as const;
    }

    if (message.role === 'assistant') {
      return {
        type: 'function_call' as const,
        call_id: message.toolCall.id,
        name: message.toolCall.name,
        arguments: JSON.stringify(message.toolCall.arguments),
      };
    }

    return {
      type: 'function_call_output' as const,
      call_id: message.toolCallId,
      output: message.content,
    };
  });
}

function toChatMessages(messages: Message[]) {
  return messages.map((message) => {
    if (message.role === 'system' || message.role === 'user' || ('content' in message && message.role === 'assistant')) {
      return { role: message.role, content: message.content } as const;
    }

    if (message.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: message.toolCall.id,
            type: 'function' as const,
            function: {
              name: message.toolCall.name,
              arguments: JSON.stringify(message.toolCall.arguments),
            },
          },
        ],
      };
    }

    return {
      role: 'tool' as const,
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  });
}

export function getProvider(): Provider {
  const provider = requiredEnv('LLM_PROVIDER');

  if (provider === 'openai') {
    const model = requiredEnv('OPENAI_MODEL');
    const client = new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });

    return {
      async generate(messages, tools = [], signal) {
        const response = await client.responses.create({
          model,
          input: toOpenAIInput(messages),
          tools: tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
        }, { signal });

        const functionCall = response.output.find((item) => item.type === 'function_call');

        return {
          text: response.output_text || undefined,
          toolCall: functionCall && {
            id: functionCall.call_id,
            name: functionCall.name,
            arguments: parseToolArguments(functionCall.arguments),
          },
          id: response.id,
          model: response.model,
          usage: response.usage && {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
          },
        };
      },
    };
  }

  if (provider === 'kimi' || provider === 'moonshot') {
    const model = requiredEnv('MOONSHOT_MODEL');
    const client = new OpenAI({
      apiKey: requiredEnv('MOONSHOT_API_KEY'),
      baseURL: requiredEnv('MOONSHOT_BASE_URL'),
      organization: null,
      project: null,
    });

    return {
      async generate(messages, tools = [], signal) {
        const response = await client.chat.completions.create({
          model,
          messages: toChatMessages(messages),
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }, { signal });

        const message = response.choices[0]?.message;
        const functionCall = message?.tool_calls?.[0];

        return {
          text: message?.content || undefined,
          toolCall: functionCall?.type === 'function' ? {
            id: functionCall.id,
            name: functionCall.function.name,
            arguments: parseToolArguments(functionCall.function.arguments),
          } : undefined,
          id: response.id,
          model: response.model,
          usage: response.usage && {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          },
        };
      },
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
