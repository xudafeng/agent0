import assert from 'node:assert/strict';
import test from 'node:test';
import { getProvider } from '../src/provider.js';

test('providers expose the same generation contract', async (t) => {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'test-model',
    MOONSHOT_API_KEY: 'test-key', MOONSHOT_MODEL: 'test-model',
    MOONSHOT_BASE_URL: 'https://example.com/v1',
  };
  try {
    for (const name of ['openai', 'kimi']) {
      await t.test(name, async (t) => {
        process.env.LLM_PROVIDER = name;
        let status = 200;
        let response: object = name === 'openai'
          ? { object: 'response', id: 'test-id', model: 'test-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }
          : { id: 'test-id', model: 'test-model', choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
        t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
          assert.ok(String(url).endsWith(name === 'openai' ? '/responses' : '/chat/completions'));
          assert.deepEqual(JSON.parse(init.body as string), name === 'openai'
            ? { model: 'test-model', input: [{ role: 'user', content: 'hi' }], tools: [] }
            : { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [] });
          return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
        });
        const provider = getProvider();
        const messages = [{ role: 'user' as const, content: 'hi' }];
        assert.deepEqual(await provider.generate(messages), {
          text: 'hello', toolCall: undefined, id: 'test-id', model: 'test-model',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        });
        delete (response as { usage?: object }).usage;
        assert.equal((await provider.generate(messages)).usage, undefined);
        response = { output: [], choices: [] };
        const empty = await provider.generate(messages);
        assert.equal(empty.text, undefined);
        assert.equal(empty.toolCall, undefined);
        status = 401;
        response = { error: { message: 'invalid key' } };
        await assert.rejects(provider.generate(messages), /401/);
      });
    }
  } finally { process.env = originalEnv; }
});
