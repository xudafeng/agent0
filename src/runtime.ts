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
import { adaptToolDefinitions, createToolRegistry, localAgentTools, ToolExecutionDeniedError, type ToolExecutionPolicy } from './tools.js';

export interface RuntimeOptions {
  maxSteps?: number;
  skillDirectories?: string[];
  toolPolicy?: ToolExecutionPolicy;
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
  const toolRegistry = createToolRegistry([
    ...localAgentTools,
    ...adaptToolDefinitions(skills.tools, (toolCall, context) => skills.callTool(toolCall, context.signal), 'sequential'),
    ...adaptToolDefinitions(taskRuntime.tools, (toolCall) => taskRuntime.callTool(toolCall), 'sequential'),
    ...adaptToolDefinitions(subagentRuntime.tools, (toolCall, context) => subagentRuntime.callTool(toolCall, context.signal)),
    ...adaptToolDefinitions(mcp.tools, (toolCall, context) => mcp.callTool(toolCall, context.signal)),
  ], options.toolPolicy);
  const tools = toolRegistry.definitions;
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
          const { text, toolCalls, ...metadata } = result;

          await emit({
            ...base(),
            type: 'model_result',
            step,
            metadata,
            contextMessages: context.length,
            ...(toolCalls?.length ? { toolCalls: toolCalls.map(({ name, arguments: arguments_ }) => ({ name, arguments: arguments_ })) } : {}),
            hasText: Boolean(text),
          });

          if (toolCalls?.length) {
            messages.push({ role: 'assistant', toolCalls });

            const executeOne = async (toolCall: (typeof toolCalls)[number]) => {
              await emit({ ...base(), type: 'tool_start', step, toolCall });

              let toolContent: string;
              let isError = false;
              try {
                if (!availableTools.some((tool) => tool.name === toolCall.name)) {
                  throw new Error('Tool is not available for this step.');
                }
                const toolResult = await toolRegistry.execute(
                  toolCall,
                  signal ? { signal } : {},
                );
                toolContent = JSON.stringify({ ok: true, result: toolResult });
              } catch (error) {
                if (signal?.aborted) throw signal.reason ?? error;
                isError = true;
                if (error instanceof ToolExecutionDeniedError) {
                  await emit({
                    ...base(),
                    type: 'tool_blocked',
                    step,
                    toolCall,
                    reason: error.reason,
                  });
                }
                toolContent = JSON.stringify({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }

              await emit({
                ...base(),
                type: 'tool_end',
                step,
                toolCallId: toolCall.id,
                name: toolCall.name,
                result: toolContent,
                isError,
              });
              return { toolCall, toolContent };
            };

            const sequential = toolCalls.some((toolCall) => toolRegistry.executionMode(toolCall.name) === 'sequential');
            const toolResults: Array<{ toolCall: (typeof toolCalls)[number]; toolContent: string }> = [];

            if (sequential) {
              for (const toolCall of toolCalls) {
                toolResults.push(await executeOne(toolCall));
              }
            } else {
              toolResults.push(...await Promise.all(toolCalls.map(executeOne)));
            }

            for (const { toolCall, toolContent } of toolResults) {
              messages.push({ role: 'tool', toolCallId: toolCall.id, content: toolContent });
            }

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
