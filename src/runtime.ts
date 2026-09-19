import { buildContext } from './context.js';
import { loadMemory, remember as persistMemory } from './memory.js';
import { connectMcpServers } from './mcp.js';
import { getProvider, type Message } from './provider.js';
import { createSubagentRuntime } from './subagent.js';
import { createTaskRuntime, formatTaskState, type TaskState } from './task.js';
import { createTraceRecorder, type TraceEvent } from './trace.js';
import { executeTool, tools as localTools } from './tools.js';

export interface RuntimeOptions {
  maxSteps?: number;
}

export interface RunResult {
  runId: string;
  text: string;
  steps: number;
}

export interface AgentRuntime {
  run(prompt: string, onEvent?: (event: TraceEvent) => void): Promise<RunResult>;
  remember(content: string): Promise<void>;
  getMemory(): string;
  getTaskState(): TaskState | undefined;
  close(): Promise<void>;
}

export async function createAgentRuntime(options: RuntimeOptions = {}): Promise<AgentRuntime> {
  const maxSteps = options.maxSteps ?? 8;
  const provider = getProvider();
  const messages: Message[] = [];
  const mcp = await connectMcpServers();
  const taskRuntime = createTaskRuntime();
  const subagentRuntime = createSubagentRuntime(provider);
  const tools = [...localTools, ...taskRuntime.tools, ...subagentRuntime.tools, ...mcp.tools];
  let memory = await loadMemory();

  return {
    async run(prompt, onEvent) {
      const value = prompt.trim();
      if (!value) {
        throw new Error('Prompt cannot be empty.');
      }

      const trace = await createTraceRecorder(onEvent);
      await trace.record('run_start', { prompt: value });
      messages.push({ role: 'user', content: value });

      try {
        for (let step = 1; step <= maxSteps; step += 1) {
          const context = buildContext(memory, messages, taskRuntime.getState());
          const result = await provider.generate(context, tools);
          const { text, toolCall, ...metadata } = result;

          await trace.record(
            'model_result',
            {
              metadata,
              contextMessages: context.length,
              toolCall: toolCall && { name: toolCall.name, arguments: toolCall.arguments },
              hasText: Boolean(text),
            },
            step,
          );

          if (toolCall) {
            messages.push({ role: 'assistant', toolCall });
            await trace.record('tool_call', { name: toolCall.name, arguments: toolCall.arguments }, step);

            let toolContent: string;
            try {
              const toolResult = taskRuntime.hasTool(toolCall.name)
                ? taskRuntime.callTool(toolCall)
                : subagentRuntime.hasTool(toolCall.name)
                  ? await subagentRuntime.callTool(toolCall)
                  : mcp.hasTool(toolCall.name)
                    ? await mcp.callTool(toolCall)
                    : executeTool(toolCall);
              toolContent = JSON.stringify({ ok: true, result: toolResult });
            } catch (error) {
              toolContent = JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            messages.push({ role: 'tool', toolCallId: toolCall.id, content: toolContent });
            await trace.record('tool_result', { name: toolCall.name, content: toolContent }, step);
            continue;
          }

          if (text) {
            messages.push({ role: 'assistant', content: text });
            await trace.record('final_answer', { text }, step);
            return { runId: trace.runId, text, steps: step };
          }

          throw new Error('Provider returned neither text nor a tool call.');
        }

        throw new Error(`Agent run exceeded max steps: ${maxSteps}`);
      } catch (error) {
        await trace.record('run_error', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async remember(content) {
      await persistMemory(content);
      memory = await loadMemory();
    },

    getMemory() {
      return memory;
    },

    getTaskState() {
      return taskRuntime.getState();
    },

    async close() {
      await mcp.close();
    },
  };
}

export function describeTaskState(state: TaskState | undefined): string {
  return formatTaskState(state) || 'No active task plan.';
}
