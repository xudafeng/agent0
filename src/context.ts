import type { Message } from './provider.js';
import { formatTaskState, type TaskState } from './task.js';

export interface ContextBudget {
  memoryChars: number;
  conversationChars: number;
  skillChars: number;
  taskChars: number;
  computerChars: number;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  memoryChars: 4000,
  conversationChars: 12000,
  skillChars: 5000,
  taskChars: 3000,
  computerChars: 1500,
};

function clamp(value: string, maxChars: number, keepEnd = false): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  return keepEnd
    ? `…${value.slice(-(maxChars - 1))}`
    : `${value.slice(0, maxChars - 1)}…`;
}

function messageCost(message: Message): number {
  if ('content' in message) return message.content.length;
  if (message.role === 'assistant') {
    return message.toolCalls.reduce((sum, call) =>
      sum + call.name.length + JSON.stringify(call.arguments).length, 0);
  }
  return 0;
}

function selectRecentConversation(messages: Message[], maxChars: number): Message[] {
  const segments: Message[][] = [];
  let current: Message[] = [];

  for (const message of messages) {
    if (message.role === 'user' && current.length) {
      segments.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) segments.push(current);

  const selected: Message[][] = [];
  let used = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const cost = segment.reduce((sum, message) => sum + messageCost(message), 0);
    if (selected.length > 0 && used + cost > maxChars) break;
    selected.push(segment);
    used += cost;
  }

  return selected.reverse().flat();
}

export function buildContext(
  memoryContext: string,
  messages: Message[],
  taskState?: TaskState,
  skillContext = '',
  computerContext = '',
  budget: Partial<ContextBudget> = {},
): Message[] {
  const limits = { ...DEFAULT_CONTEXT_BUDGET, ...budget };
  const recentConversation = selectRecentConversation(messages, limits.conversationChars);
  const task = formatTaskState(taskState);
  const systemSections = [
    computerContext ? clamp(computerContext, limits.computerChars) : '',
    skillContext ? clamp(skillContext, limits.skillChars) : '',
    memoryContext ? `Relevant persistent memory:\n\n${clamp(memoryContext, limits.memoryChars)}` : '',
    task ? `Current task state:\n\n${clamp(task, limits.taskChars)}` : '',
  ].filter(Boolean);

  if (systemSections.length === 0) {
    return recentConversation;
  }

  return [
    {
      role: 'system',
      content: systemSections.join('\n\n'),
    },
    ...recentConversation,
  ];
}
