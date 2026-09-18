import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext } from './context.js';
import type { Message } from './provider.js';

test('keeps only the most recent four user turns', () => {
  const messages: Message[] = [];

  for (let i = 1; i <= 5; i += 1) {
    messages.push({ role: 'user', content: `user-${i}` });
    messages.push({ role: 'assistant', content: `assistant-${i}` });
  }

  const context = buildContext('', messages);

  assert.equal(context[0]?.role, 'user');
  assert.equal('content' in context[0] ? context[0].content : undefined, 'user-2');
  assert.equal(context.length, 8);
});

test('keeps only the most recent eight memory items', () => {
  const memory = ['# Memory', '', ...Array.from({ length: 10 }, (_, i) => `- memory-${i + 1}`)].join('\n');
  const messages: Message[] = [{ role: 'user', content: 'hello' }];

  const context = buildContext(memory, messages);
  const system = context[0];

  assert.equal(system?.role, 'system');
  assert.ok(system && 'content' in system && !system.content.includes('memory-1\n'));
  assert.ok(system && 'content' in system && system.content.includes('memory-3'));
  assert.ok(system && 'content' in system && system.content.includes('memory-10'));
});
