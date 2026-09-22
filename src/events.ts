import type { ToolCall } from './tools.js';

interface AgentEventBase {
  runId: string;
  timestamp: string;
}

export type AgentEvent =
  | (AgentEventBase & { type: 'run_start'; prompt: string })
  | (AgentEventBase & { type: 'turn_start'; step: number })
  | (AgentEventBase & { type: 'jev_decision'; step: number; decision: Record<string, unknown> })
  | (AgentEventBase & {
      type: 'model_result';
      step: number;
      metadata: Record<string, unknown>;
      contextMessages: number;
      toolCall?: Pick<ToolCall, 'name' | 'arguments'>;
      hasText: boolean;
    })
  | (AgentEventBase & { type: 'tool_start'; step: number; toolCall: ToolCall })
  | (AgentEventBase & {
      type: 'tool_end';
      step: number;
      toolCallId: string;
      name: string;
      result: string;
      isError: boolean;
    })
  | (AgentEventBase & { type: 'turn_end'; step: number })
  | (AgentEventBase & { type: 'run_end'; text: string; steps: number })
  | (AgentEventBase & { type: 'run_cancelled'; reason?: string })
  | (AgentEventBase & { type: 'run_error'; error: string });

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;
