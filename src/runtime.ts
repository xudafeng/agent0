import { randomUUID } from 'node:crypto';
import { buildContext } from './context.js';
import type { AgentEvent, AgentEventHandler } from './events.js';
import { createJevRouter } from './jev.js';
import { loadMemory, remember as persistMemory } from './memory.js';
import { connectMcpServers } from './mcp.js';
import { getProvider, type Message } from './provider.js';
import { createSkillRuntime, type SkillSummary } from './skills.js';
import { createSubagentRuntime } from './subagent.js';
import { createTaskRuntime, formatTaskState, type TaskState } from './task.js';
import { createTraceRecorder } from './trace.js';
import { executeTool, tools as localTools } from './tools.js';

export interface RuntimeOptions {
  maxSteps?: number;
  skillDirectories?: string[];
}

export interface RunResult {
  runId: string;
  text: string;
  steps: number;
}

export interface RunOptions {
  onEvent?: AgentEventHandler;
  signal?: AbortSignal;
}

export interface AgentRuntime {
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
  remember(content: string): Promise<void>;
  getMemory(): string;
  getTaskState(): TaskState | undefined;
  getSkills(): { skills: SkillSummary[]; diagnostics: string[]; loaded: string[] };
  close(): Promise<void>;
}

export async function createAgentRuntime(options: RuntimeOptions = {}): Promise<AgentRuntime> {
  const maxSteps = options.maxSteps ?? 8;
  const provider = getProvider();
  const route = createJevRouter();
  const messages: Message[] = [];
  const skills = await createSkillRuntime(options.skillDirectories);
  const mcp = await connectMcpServers();
  const taskRuntime = createTaskRuntime();
  const subagentRuntime = createSubagentRuntime(provider);
  const tools = [...localTools, ...skills.tools, ...taskRuntime.tools, ...subagentRuntime.tools, ...mcp.tools];
  let memory = await loadMemory();

  return {
    async run(prompt, options = {}) {
      const { onEvent, signal } = options;
      signal?.throwIfAborted();
      const value = prompt.trim();
      if (!value) {
        throw new Error('Prompt cannot be empty.');
      }

      const runId = randomUUID();
      const trace = await createTraceRecorder();
      const emit = async (event: AgentEvent) => {
        await trace.record(event);
        await onEvent?.(event);
      };
      const base = () => ({ runId, timestamp: new Date().toISOString() });

      await emit({ ...base(), type: 'run_start', prompt: value });
      messages.push({ role: 'user', content: value });

      try {
        for (let step = 1; step <= maxSteps; step += 1) {
          signal?.throwIfAborted();
          await emit({ ...base(), type: 'turn_start', step });

          const context = buildContext(memory, messages, taskRuntime.getState(), skills.context());
          const routed = await route?.(context, tools, signal);
          if (routed) {
            await emit({ ...base(), type: 'jev_decision', step, decision: { ...routed.decision } });
          }

          const availableTools = routed?.tools ?? tools;
          const result = await provider.generate(context, availableTools, signal);
          const { text, toolCall, ...metadata } = result;

          await emit({
            ...base(),
            type: 'model_result',
            step,
            metadata,
            contextMessages: context.length,
            ...(toolCall ? { toolCall: { name: toolCall.name, arguments: toolCall.arguments } } : {}),
            hasText: Boolean(text),
          });

          if (toolCall) {
            messages.push({ role: 'assistant', toolCall });
            await emit({ ...base(), type: 'tool_start', step, toolCall });

            let toolContent: string;
            let isError = false;
            try {
              if (!availableTools.some((tool) => tool.name === toolCall.name)) {
                throw new Error('Tool is not available for this step.');
              }
              signal?.throwIfAborted();
              const toolResult = skills.hasTool(toolCall.name)
                ? await skills.callTool(toolCall, signal)
                : taskRuntime.hasTool(toolCall.name)
                  ? taskRuntime.callTool(toolCall)
                  : subagentRuntime.hasTool(toolCall.name)
                    ? await subagentRuntime.callTool(toolCall, signal)
                    : mcp.hasTool(toolCall.name)
                      ? await mcp.callTool(toolCall, signal)
                      : executeTool(toolCall);
              toolContent = JSON.stringify({ ok: true, result: toolResult });
            } catch (error) {
              if (signal?.aborted) throw signal.reason ?? error;
              isError = true;
              toolContent = JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            messages.push({ role: 'tool', toolCallId: toolCall.id, content: toolContent });
            await emit({
              ...base(),
              type: 'tool_end',
              step,
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: toolContent,
              isError,
            });
            await emit({ ...base(), type: 'turn_end', step });
            continue;
          }

          if (text) {
            messages.push({ role: 'assistant', content: text });
            await emit({ ...base(), type: 'turn_end', step });
            await emit({ ...base(), type: 'run_end', text, steps: step });
            return { runId, text, steps: step };
          }

          throw new Error('Provider returned neither text nor a tool call.');
        }

        throw new Error(`Agent run exceeded max steps: ${maxSteps}`);
      } catch (error) {
        if (signal?.aborted) {
          await emit({
            ...base(),
            type: 'run_cancelled',
            ...(signal.reason === undefined ? {} : { reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason) }),
          });
          throw error;
        }
        await emit({
          ...base(),
          type: 'run_error',
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

    getSkills() {
      return { skills: skills.list(), diagnostics: [...skills.diagnostics], loaded: skills.loaded() };
    },

    async close() {
      await mcp.close();
    },
  };
}

export function describeTaskState(state: TaskState | undefined): string {
  return formatTaskState(state) || 'No active task plan.';
}
