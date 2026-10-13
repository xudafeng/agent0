import { z } from 'zod';
import { ExaApiError, type ExaClient, type ExaSearchResponse } from './exa.js';
import type { AgentTool } from './tools.js';

const searchTypeSchema = z.enum(['auto', 'fast', 'instant']);

const isoDateTime = z.string().trim().refine((value) =>
  value.includes('T') && !Number.isNaN(Date.parse(value)),
{ message: 'Expected an ISO 8601 date-time.' });

const domainSchema = z.string().trim().min(1).max(300);

const searchSchema = z.object({
  query: z.string().trim().min(1).max(4096),
  type: searchTypeSchema.optional(),
  numResults: z.number().int().min(1).max(20).optional(),
  includeDomains: z.array(domainSchema).max(50).optional(),
  excludeDomains: z.array(domainSchema).max(50).optional(),
  startPublishedDate: isoDateTime.optional(),
  endPublishedDate: isoDateTime.optional(),
  maxAgeHours: z.number().int().min(-1).max(8760).optional(),
  maxCharactersPerResult: z.number().int().min(200).max(8000).optional(),
}).strict();

const fetchSchema = z.object({
  url: z.string().trim().min(1).max(4000),
  mode: z.enum(['highlights', 'text']).optional(),
  query: z.string().trim().min(1).max(4096).optional(),
  maxCharacters: z.number().int().min(200).max(30000).optional(),
  maxAgeHours: z.number().int().min(-1).max(8760).optional(),
}).strict();

function validateWebUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('url must be a valid absolute URL.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('url must use HTTP or HTTPS without embedded credentials.');
  }
  return url.toString();
}

function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function trimSearch(response: ExaSearchResponse, maxCharactersPerResult: number) {
  const results = response.results.map((result) => ({
    ...result,
    highlights: result.highlights.reduce<string[]>((selected, highlight) => {
      const used = selected.reduce((sum, item) => sum + item.length, 0);
      const remaining = maxCharactersPerResult - used;
      if (remaining <= 0) return selected;
      selected.push(cap(highlight, remaining));
      return selected;
    }, []),
  }));

  return {
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    results,
    ...(response.searchTime === undefined ? {} : { searchTime: response.searchTime }),
    ...(response.costDollars === undefined ? {} : { costDollars: response.costDollars }),
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof ExaApiError) return error.retryable;
  if (error instanceof TypeError) return true;
  return error instanceof Error && error.name === 'ToolExecutionTimeoutError';
}

const retry = {
  maxAttempts: 3,
  delayMs: 300,
  shouldRetry: retryable,
} as const;

export function createWebTools(exa: ExaClient): AgentTool[] {
  return [
    {
      definition: {
        name: 'web_search',
        description: 'Search the live web with Exa and return ranked sources plus query-relevant highlights. Use this to discover sources; prefer web_fetch for deeper reading of a known URL.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language web search query.' },
            type: {
              type: 'string',
              enum: ['auto', 'fast', 'instant'],
              description: 'Search mode. auto is the default; fast/instant trade some depth for latency.',
            },
            numResults: { type: 'number', description: 'Number of results, from 1 to 20.' },
            includeDomains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional hard allowlist of domains or domain paths.',
            },
            excludeDomains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional hard blocklist of domains or domain paths.',
            },
            startPublishedDate: {
              type: 'string',
              description: 'Optional ISO 8601 date-time. Only return pages published after this time.',
            },
            endPublishedDate: {
              type: 'string',
              description: 'Optional ISO 8601 date-time. Only return pages published before this time.',
            },
            maxAgeHours: {
              type: 'number',
              description: 'Optional content freshness: 0 always fetches fresh, -1 uses cache only, positive values accept cache up to that many hours old.',
            },
            maxCharactersPerResult: {
              type: 'number',
              description: 'Maximum highlight characters retained per result, from 200 to 8000.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      executionMode: 'parallel',
      idempotency: 'idempotent',
      retry,
      timeoutMs: 30000,
      async execute(toolCall, context) {
        const parsed = searchSchema.parse(toolCall.arguments);
        const response = await exa.search({
          query: parsed.query,
          ...(parsed.type === undefined ? {} : { type: parsed.type }),
          ...(parsed.numResults === undefined ? {} : { numResults: parsed.numResults }),
          ...(parsed.includeDomains === undefined ? {} : { includeDomains: parsed.includeDomains }),
          ...(parsed.excludeDomains === undefined ? {} : { excludeDomains: parsed.excludeDomains }),
          ...(parsed.startPublishedDate === undefined ? {} : { startPublishedDate: parsed.startPublishedDate }),
          ...(parsed.endPublishedDate === undefined ? {} : { endPublishedDate: parsed.endPublishedDate }),
          ...(parsed.maxAgeHours === undefined ? {} : { maxAgeHours: parsed.maxAgeHours }),
        }, context.signal);
        return trimSearch(response, parsed.maxCharactersPerResult ?? 3000);
      },
    },
    {
      definition: {
        name: 'web_fetch',
        description: 'Retrieve clean LLM-ready content for one known HTTP(S) URL with Exa Contents. Defaults to relevant highlights; request text only when broader page context is needed.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute HTTP or HTTPS URL without embedded credentials.' },
            mode: {
              type: 'string',
              enum: ['highlights', 'text'],
              description: 'highlights is token-efficient and default; text returns broader clean page content.',
            },
            query: {
              type: 'string',
              description: 'Optional focus query used when mode=highlights.',
            },
            maxCharacters: {
              type: 'number',
              description: 'Maximum returned content characters, from 200 to 30000.',
            },
            maxAgeHours: {
              type: 'number',
              description: 'Optional content freshness: 0 always fetches fresh, -1 uses cache only, positive values accept cache up to that many hours old.',
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
      executionMode: 'parallel',
      idempotency: 'idempotent',
      retry,
      timeoutMs: 30000,
      execute(toolCall, context) {
        const parsed = fetchSchema.parse(toolCall.arguments);
        return exa.fetch({
          url: validateWebUrl(parsed.url),
          ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
          ...(parsed.query === undefined ? {} : { query: parsed.query }),
          ...(parsed.maxCharacters === undefined ? {} : { maxCharacters: parsed.maxCharacters }),
          ...(parsed.maxAgeHours === undefined ? {} : { maxAgeHours: parsed.maxAgeHours }),
        }, context.signal);
      },
    },
  ];
}
