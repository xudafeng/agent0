import assert from 'node:assert/strict';
import test from 'node:test';
import { getProvider } from '../src/provider.js';

test('providers expose the same generation contract', async (t) => {
  const originalEnv = process.env;
  process.env = {
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'test-model',
    MOONSHOT_API_KEY: 'test-key',
    MOONSHOT_MODEL: 'test-model',
    MOONSHOT_BASE_URL: 'https://example.com/v1',
  };

  try {
    for (const name of ['openai', 'kimi']) {
      await t.test(name, async (t) => {
        process.env.LLM_PROVIDER = name;
        let status = 200;
        let response: object = name === 'openai'
          ? {
              id: 'test-id', model: 'test-model', output_text: 'hello',
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            }
          : {
              id: 'test-id', model: 'test-model',
              choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            };
        t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
          assert.ok(String(url).endsWith(name === 'openai' ? '/responses' : '/chat/completions'));
          assert.deepEqual(JSON.parse(init.body as string), name === 'openai'
            ? { model: 'test-model', input: 'hi' }
            : { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] });
          return new Response(JSON.stringify(response), {
            status, headers: { 'content-type': 'application/json' },
          });
        });

        const provider = getProvider();
        assert.deepEqual(Object.keys(provider), ['generate']);
        assert.deepEqual(await provider.generate('hi'), {
          text: 'hello', id: 'test-id', model: 'test-model',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        });

        delete (response as { usage?: object }).usage;
        assert.equal((await provider.generate('hi')).usage, undefined);

        response = { output_text: '', choices: [] };
        await assert.rejects(provider.generate('hi'), /returned no text content/);

        status = 401;
        response = { error: { message: 'invalid key' } };
        await assert.rejects(provider.generate('hi'), /401/);
      });
    }
  } finally {
    process.env = originalEnv;
  }
});
