import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevRouter, jevConfiguration } from '../src/jev.js';
import { tools } from '../src/tools.js';
import type { Message } from '../src/provider.js';

const env = { JEV_ENABLED: 'true', TYPESAFE_API_KEY: 'private-key' };
const messages: Message[] = [{ role: 'user', content: 'Add 2 and 3.' }];
const answer = (choice = 'tool_0', confidence = 0.9) => ({
  model: 'jev-test', answers: { route: { type: 'choice', choice, confidence,
    probabilities: { tool_0: choice === 'tool_0' ? 0.97 : 0.01, tool_1: 0.01, tool_2: 0.01, defer: choice === 'tool_0' ? 0.01 : 0.97 } } },
});
const mock = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test('routing is opt-in and configuration never exposes the API key', () => {
  assert.equal(createJevRouter({ TYPESAFE_API_KEY: 'private-key' }), undefined);
  assert.equal(JSON.stringify(jevConfiguration(env)).includes('private-key'), false);
});

test('sends the documented Choice request and narrows tools without executing them', async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer private-key');
    const input = JSON.parse(String(options?.body));
    assert.equal(input.model, 'jev-latest');
    assert.deepEqual(JSON.parse(input.state).messages, messages);
    assert.equal(input.questions.route.type, 'choice');
    assert.match(input.questions.route.criteria.tool_0, /add:/);
    assert.ok(input.questions.route.criteria.defer);
    return new Response(JSON.stringify(answer()));
  };
  const result = await createJevRouter(env, request)!(messages, tools);
  assert.deepEqual(result.tools, [tools[0]]);
  assert.equal(result.decision.status, 'selected');
  assert.equal(result.decision.selectedTool, 'add');
  assert.equal(result.decision.model, 'jev-test');
  assert.equal(result.decision.probabilities?.add, 0.97);
  assert.ok(result.decision.durationMs >= 0);
});

test('uncertainty and defer preserve the full tool set', async () => {
  for (const [body, reason] of [[answer('tool_0', 0.79), 'low_confidence'], [answer('defer'), 'deferred']] as const) {
    const result = await createJevRouter(env, mock(body))!(messages, tools);
    assert.equal(result.tools, tools);
    assert.equal(result.decision.reason, reason);
  }
});

test('invalid answers and HTTP errors fall back without exposing upstream secrets', async () => {
  const unknown = answer(); unknown.answers.route.choice = 'unknown';
  const badSum = answer(); badSum.answers.route.probabilities.tool_0 = 0.5;
  const missing = answer(); delete (missing.answers.route.probabilities as Record<string, number>).defer;
  const cases = [mock(unknown), mock(badSum), mock(missing), mock(answer('tool_0', 2)), mock({ secret: 'private-key' }), mock({ secret: 'private-key' }, 401)];
  for (const request of cases) {
    const result = await createJevRouter(env, request)!(messages, tools);
    assert.equal(result.tools, tools);
    assert.equal(result.decision.status, 'fallback');
    assert.ok(!JSON.stringify(result.decision).includes('private-key'));
  }
});

test('network failures and timeouts fall back', async () => {
  const failed: typeof fetch = async () => { throw new Error('private-key'); };
  assert.equal((await createJevRouter(env, failed)!(messages, tools)).decision.reason, 'request_failed');
  const pending: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mock did not abort')), 1000);
    options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal!.reason); });
  });
  assert.equal((await createJevRouter({ ...env, JEV_TIMEOUT_MS: '5' }, pending)!(messages, tools)).decision.reason, 'timeout');
});

test('configuration and payload limits skip network calls', async () => {
  const request: typeof fetch = async () => { assert.fail('Unexpected network request'); };
  for (const [overrides, reason] of [
    [{ TYPESAFE_API_KEY: '' }, 'missing_key'],
    [{ JEV_MIN_CONFIDENCE: 'NaN' }, 'invalid_configuration'],
    [{ JEV_TIMEOUT_MS: '0' }, 'invalid_configuration'],
    [{ JEV_ENDPOINT: 'http://example.com' }, 'invalid_configuration'],
  ] as const) {
    assert.equal((await createJevRouter({ ...env, ...overrides }, request)!(messages, tools)).decision.reason, reason);
  }
  const route = createJevRouter(env, request)!;
  assert.equal((await route(messages, Array(255).fill(tools[0]))).decision.reason, 'tool_limit');
  assert.equal((await route([{ role: 'user', content: 'a'.repeat(64001) }], tools)).decision.reason, 'context_limit');
});


test('caller cancellation is propagated instead of becoming a fallback', async () => {
  const pending: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  });
  const controller = new AbortController();
  const route = createJevRouter(env, pending)!;
  const result = route(messages, tools, controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(result, /stop/);
});
