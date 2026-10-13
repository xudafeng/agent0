import assert from 'node:assert/strict';
import test from 'node:test';
import { createExaClient, ExaApiError } from '../src/exa.js';

test('Exa search sends current Search API shape and normalizes results', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    return new Response(JSON.stringify({
      requestId: 'req-search',
      results: [{
        title: 'Example result',
        url: 'https://example.com/post',
        publishedDate: '2026-10-12T00:00:00Z',
        author: 'Example Author',
        highlights: ['Relevant passage'],
      }],
      searchTime: 42,
      costDollars: { total: 0.001 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const exa = createExaClient({ apiKey: 'secret-key', fetchImpl });
  const result = await exa.search({
    query: 'latest agent runtime work',
    type: 'fast',
    numResults: 5,
    includeDomains: ['example.com'],
    excludeDomains: ['spam.example'],
    startPublishedDate: '2026-10-01T00:00:00Z',
    endPublishedDate: '2026-10-13T00:00:00Z',
    maxAgeHours: 24,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.exa.ai/search');
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('x-api-key'), 'secret-key');
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, {
    query: 'latest agent runtime work',
    type: 'fast',
    numResults: 5,
    contents: { highlights: true, maxAgeHours: 24 },
    includeDomains: ['example.com'],
    excludeDomains: ['spam.example'],
    startPublishedDate: '2026-10-01T00:00:00Z',
    endPublishedDate: '2026-10-13T00:00:00Z',
  });
  assert.equal(result.requestId, 'req-search');
  assert.equal(result.results[0]?.url, 'https://example.com/post');
  assert.deepEqual(result.results[0]?.highlights, ['Relevant passage']);
  assert.equal(result.costDollars, 0.001);
});

test('Exa Contents uses top-level highlights or text options', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      requestId: 'req-contents',
      results: [{
        id: 'https://example.com/report',
        title: 'Report',
        url: 'https://example.com/report',
        highlights: ['Focused evidence'],
        text: '# Report\n\nFull content',
      }],
      statuses: [{
        id: 'https://example.com/report',
        status: 'success',
        source: 'cached',
      }],
      costDollars: { total: 0.002 },
    }), { status: 200 });
  };

  const exa = createExaClient({ apiKey: 'secret-key', fetchImpl });

  const highlighted = await exa.fetch({
    url: 'https://example.com/report',
    mode: 'highlights',
    query: 'methodology',
    maxCharacters: 2000,
    maxAgeHours: 12,
  });
  assert.deepEqual(bodies[0], {
    ids: ['https://example.com/report'],
    highlights: { query: 'methodology' },
    maxAgeHours: 12,
  });
  assert.deepEqual(highlighted.highlights, ['Focused evidence']);
  assert.equal(highlighted.status, 'success');

  const text = await exa.fetch({
    url: 'https://example.com/report',
    mode: 'text',
    maxCharacters: 8000,
  });
  assert.deepEqual(bodies[1], {
    ids: ['https://example.com/report'],
    text: { maxCharacters: 8000 },
  });
  assert.ok(text.text?.includes('Full content'));
});

test('Exa client surfaces retryable HTTP errors without leaking credentials', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    requestId: 'req-rate-limit',
    error: 'rate limited',
  }), { status: 429 });

  const exa = createExaClient({ apiKey: 'super-secret', fetchImpl });

  await assert.rejects(
    exa.search({ query: 'test' }),
    (error: unknown) => {
      assert.ok(error instanceof ExaApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes('super-secret'));
      return true;
    },
  );
});

test('Exa client rejects oversized raw responses', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    results: [{ title: 'x', url: 'https://example.com', highlights: ['x'.repeat(2048)] }],
  }), { status: 200 });

  const exa = createExaClient({
    apiKey: 'secret-key',
    fetchImpl,
    maxResponseBytes: 256,
  });

  await assert.rejects(exa.search({ query: 'test' }), /response exceeded 256 bytes/);
});
