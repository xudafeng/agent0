import assert from 'node:assert/strict';
import test from 'node:test';
import { ExaApiError, type ExaClient } from '../src/exa.js';
import { createToolRegistry } from '../src/tools.js';
import { createWebTools } from '../src/web-tools.js';

test('web_search retries transient Exa errors and trims highlights', async () => {
  let calls = 0;
  const exa: ExaClient = {
    async search() {
      calls += 1;
      if (calls === 1) throw new ExaApiError('temporary', 503);
      return {
        results: [{
          title: 'Result',
          url: 'https://example.com/',
          highlights: ['a'.repeat(1000), 'b'.repeat(1000)],
        }],
      };
    },
    async fetch() {
      throw new Error('unused');
    },
  };

  const registry = createToolRegistry(createWebTools(exa));
  const result = await registry.execute({
    id: 'search-1',
    name: 'web_search',
    arguments: {
      query: 'agent runtime',
      numResults: 3,
      maxCharactersPerResult: 500,
    },
  }) as { results: Array<{ highlights: string[] }> };

  assert.equal(calls, 2);
  assert.equal(result.results[0]?.highlights.join('').length, 500);
});

test('web_search forwards domain and publication filters', async () => {
  let seen: unknown;
  const exa: ExaClient = {
    async search(input) {
      seen = input;
      return { results: [] };
    },
    async fetch() {
      throw new Error('unused');
    },
  };

  const registry = createToolRegistry(createWebTools(exa));
  await registry.execute({
    id: 'search-2',
    name: 'web_search',
    arguments: {
      query: 'model releases',
      includeDomains: ['openai.com', 'anthropic.com/news'],
      startPublishedDate: '2026-10-01T00:00:00Z',
      endPublishedDate: '2026-10-13T00:00:00Z',
      maxAgeHours: 0,
    },
  });

  assert.deepEqual(seen, {
    query: 'model releases',
    includeDomains: ['openai.com', 'anthropic.com/news'],
    startPublishedDate: '2026-10-01T00:00:00Z',
    endPublishedDate: '2026-10-13T00:00:00Z',
    maxAgeHours: 0,
  });
});

test('web_fetch validates URLs and forwards focused retrieval options', async () => {
  let seen: unknown;
  const exa: ExaClient = {
    async search() {
      throw new Error('unused');
    },
    async fetch(input) {
      seen = input;
      return {
        title: 'Example',
        url: input.url,
        highlights: ['Evidence'],
      };
    },
  };

  const registry = createToolRegistry(createWebTools(exa));
  await registry.execute({
    id: 'fetch-1',
    name: 'web_fetch',
    arguments: {
      url: 'https://example.com/research',
      query: 'results',
      mode: 'highlights',
      maxCharacters: 5000,
      maxAgeHours: 24,
    },
  });

  assert.deepEqual(seen, {
    url: 'https://example.com/research',
    mode: 'highlights',
    query: 'results',
    maxCharacters: 5000,
    maxAgeHours: 24,
  });

  await assert.rejects(
    registry.execute({
      id: 'fetch-2',
      name: 'web_fetch',
      arguments: { url: 'file:///etc/passwd' },
    }),
    /HTTP or HTTPS/,
  );

  await assert.rejects(
    registry.execute({
      id: 'fetch-3',
      name: 'web_fetch',
      arguments: { url: 'https://user:password@example.com/private' },
    }),
    /without embedded credentials/,
  );
});
