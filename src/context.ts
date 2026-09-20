import type { Message } from './provider.js';
import { formatTaskState, type TaskState } from './task.js';

const MAX_MEMORY_ITEMS = 8;
const MAX_USER_TURNS = 4;

function selectMemory(memory: string): string {
  const items = memory
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));

  return items.slice(-MAX_MEMORY_ITEMS).join('\n');
}

function selectRecentConversation(messages: Message[]): Message[] {
  const userIndexes = messages
    .map((message, index) => (message.role === 'user' ? index : -1))
    .filter((index) => index >= 0);

  if (userIndexes.length <= MAX_USER_TURNS) {
    return messages;
  }

  const startIndex = userIndexes[userIndexes.length - MAX_USER_TURNS];
  return messages.slice(startIndex);
}

export function buildContext(memory: string, messages: Message[], taskState?: TaskState, skillContext = ''): Message[] {
  const selectedMemory = selectMemory(memory);
  const recentConversation = selectRecentConversation(messages);
  const task = formatTaskState(taskState);
  const systemSections = [
    skillContext,
    selectedMemory ? `Relevant persistent memory:\n\n${selectedMemory}` : '',
    task ? `Current task state:\n\n${task}` : '',
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
