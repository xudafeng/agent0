import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext } from './context.js';
import type { Message } from './provider.js';

test('conversation budget keeps complete recent user-turn segments', () => {
  const messages: Message[] = [
    { role: 'user', content: 'old question '.repeat(20) },
    { role: 'assistant', content: 'old answer '.repeat(20) },
    { role: 'user', content: 'new question' },
    { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 1, b: 2 } }] },
    { role: 'tool', toolCallId: 'call-1', content: '{"ok":true,"result":3}' },
    { role: 'assistant', content: 'new answer' },
  ];

  const context = buildContext('', messages, undefined, '', '', {
    conversationChars: 100,
  });

  assert.equal(context[0]?.role, 'user');
  assert.equal('content' in context[0]! ? context[0].content : undefined, 'new question');
  assert.ok(context.some((message) => message.role === 'assistant' && 'toolCalls' in message));
  assert.ok(context.some((message) => message.role === 'tool' && message.toolCallId === 'call-1'));
  assert.equal(context.at(-1)?.role, 'assistant');
});

test('memory context is bounded independently from other system context', () => {
  const memory = '- [profile] ' + 'memory '.repeat(100);
  const messages: Message[] = [{ role: 'user', content: 'hello' }];

  const context = buildContext(
    memory,
    messages,
    undefined,
    'skill context',
    'computer context',
    { memoryChars: 80 },
  );
  const system = context[0];

  assert.equal(system?.role, 'system');
  assert.ok(system && 'content' in system && system.content.includes('Relevant persistent memory'));
  assert.ok(system && 'content' in system && system.content.includes('skill context'));
  assert.ok(system && 'content' in system && system.content.includes('computer context'));

  const memorySection = system && 'content' in system
    ? system.content.split('Relevant persistent memory:\n\n')[1]?.split('\n\n')[0] ?? ''
    : '';
  assert.ok(memorySection.length <= 80);
});

test('task, skill, and computer context use separate budgets', () => {
  const messages: Message[] = [{ role: 'user', content: 'hello' }];
  const context = buildContext(
    '',
    messages,
    {
      goal: 'g'.repeat(100),
      steps: [{ description: 's'.repeat(100), status: 'pending' }],
    },
    'k'.repeat(100),
    'c'.repeat(100),
    {
      skillChars: 20,
      computerChars: 20,
      taskChars: 40,
    },
  );

  const system = context[0];
  assert.equal(system?.role, 'system');
  assert.ok(system && 'content' in system);
  if (!system || !('content' in system)) return;
  assert.ok(system.content.includes('k'.repeat(19)));
  assert.ok(system.content.includes('c'.repeat(19)));
  assert.ok(system.content.includes('Current task state'));
  assert.ok(!system.content.includes('g'.repeat(80)));
});
