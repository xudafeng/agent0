export interface ExaSearchInput {
  query: string;
  type?: 'auto' | 'fast' | 'instant';
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  maxAgeHours?: number;
}

export interface ExaFetchInput {
  url: string;
  mode?: 'highlights' | 'text';
  query?: string;
  maxCharacters?: number;
  maxAgeHours?: number;
}

export interface ExaSearchResult {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights: string[];
}

export interface ExaSearchResponse {
  requestId?: string;
  results: ExaSearchResult[];
  searchTime?: number;
  costDollars?: number;
}

export interface ExaFetchResponse {
  requestId?: string;
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
  text?: string;
  status?: string;
  source?: string;
  costDollars?: number;
}

export interface ExaClient {
  search(input: ExaSearchInput, signal?: AbortSignal): Promise<ExaSearchResponse>;
  fetch(input: ExaFetchInput, signal?: AbortSignal): Promise<ExaFetchResponse>;
}

export class ExaApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ExaApiError';
  }

  get retryable(): boolean {
    return this.status === 429 || (this.status !== undefined && this.status >= 500);
  }
}

interface ExaClientOptions {
  apiKey: string;
  baseURL?: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

const DEFAULT_BASE_URL = 'https://api.exa.ai';
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_TEXT = 30000;
const MAX_HIGHLIGHT_TEXT = 12000;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function validWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ExaApiError(`Exa response exceeded ${maxBytes} bytes.`, response.status);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ExaApiError(`Exa response exceeded ${maxBytes} bytes.`, response.status);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function parseJson(text: string, status: number): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Response is not a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ExaApiError(
      `Invalid Exa JSON response: ${error instanceof Error ? error.message : String(error)}`,
      status,
    );
  }
}

function costTotal(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return optionalNumber((value as Record<string, unknown>).total);
}

function sanitizeHighlights(value: unknown, maxCharacters = MAX_HIGHLIGHT_TEXT): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  let used = 0;
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const remaining = maxCharacters - used;
    if (remaining <= 0) break;
    const next = cap(item.trim(), remaining);
    result.push(next);
    used += next.length;
  }
  return result;
}

function sanitizeSearchResult(value: unknown): ExaSearchResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const url = validWebUrl(item.url);
  if (!url) return undefined;
  const title = optionalString(item.title) ?? url;
  const publishedDate = optionalString(item.publishedDate);
  const author = optionalString(item.author);
  return {
    title: cap(title, 1000),
    url,
    ...(publishedDate === undefined ? {} : { publishedDate }),
    ...(author === undefined ? {} : { author: cap(author, 1000) }),
    highlights: sanitizeHighlights(item.highlights),
  };
}

export function createExaClient(options: ExaClientOptions): ExaClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('Exa API key cannot be empty.');
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const request = async (
    path: '/search' | '/contents',
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${baseURL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await readResponseText(response, maxResponseBytes);
    const parsed = raw ? parseJson(raw, response.status) : {};
    if (!response.ok) {
      const message = optionalString(parsed.error) ?? optionalString(parsed.message) ?? `HTTP ${response.status}`;
      throw new ExaApiError(`Exa request failed: ${message}`, response.status, optionalString(parsed.requestId));
    }
    return parsed;
  };

  return {
    async search(input, signal) {
      const contents: Record<string, unknown> = { highlights: true };
      if (input.maxAgeHours !== undefined) contents.maxAgeHours = input.maxAgeHours;

      const body: Record<string, unknown> = {
        query: input.query,
        type: input.type ?? 'auto',
        numResults: input.numResults ?? 10,
        contents,
        ...(input.includeDomains === undefined ? {} : { includeDomains: input.includeDomains }),
        ...(input.excludeDomains === undefined ? {} : { excludeDomains: input.excludeDomains }),
        ...(input.startPublishedDate === undefined ? {} : { startPublishedDate: input.startPublishedDate }),
        ...(input.endPublishedDate === undefined ? {} : { endPublishedDate: input.endPublishedDate }),
      };

      const parsed = await request('/search', body, signal);
      const results = Array.isArray(parsed.results)
        ? parsed.results.map(sanitizeSearchResult).filter((item): item is ExaSearchResult => item !== undefined)
        : [];

      return {
        ...(optionalString(parsed.requestId) === undefined ? {} : { requestId: optionalString(parsed.requestId)! }),
        results,
        ...(optionalNumber(parsed.searchTime) === undefined ? {} : { searchTime: optionalNumber(parsed.searchTime)! }),
        ...(costTotal(parsed.costDollars) === undefined ? {} : { costDollars: costTotal(parsed.costDollars)! }),
      };
    },

    async fetch(input, signal) {
      const mode = input.mode ?? 'highlights';
      const maxCharacters = Math.min(input.maxCharacters ?? 12000, MAX_TOOL_TEXT);
      const body: Record<string, unknown> = {
        ids: [input.url],
        ...(mode === 'text'
          ? { text: { maxCharacters } }
          : {
              highlights: input.query
                ? { query: input.query }
                : true,
            }),
        ...(input.maxAgeHours === undefined ? {} : { maxAgeHours: input.maxAgeHours }),
      };

      const parsed = await request('/contents', body, signal);
      const first = Array.isArray(parsed.results) && parsed.results[0] && typeof parsed.results[0] === 'object'
        ? parsed.results[0] as Record<string, unknown>
        : undefined;
      if (!first) {
        const statuses = Array.isArray(parsed.statuses) ? parsed.statuses : [];
        const firstStatus = statuses[0];
        const reason = firstStatus && typeof firstStatus === 'object' && !Array.isArray(firstStatus)
          ? optionalString((firstStatus as Record<string, unknown>).error)
            ?? optionalString((firstStatus as Record<string, unknown>).status)
          : undefined;
        throw new ExaApiError(`Exa returned no content for URL${reason ? `: ${reason}` : '.'}`);
      }

      const url = validWebUrl(first.url) ?? input.url;
      const title = cap(optionalString(first.title) ?? url, 1000);
      const publishedDate = optionalString(first.publishedDate);
      const author = optionalString(first.author);
      const text = optionalString(first.text);
      const highlights = sanitizeHighlights(first.highlights, maxCharacters);
      const statuses = Array.isArray(parsed.statuses) ? parsed.statuses : [];
      const statusItem = statuses.find((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          && ((item as Record<string, unknown>).id === input.url || (item as Record<string, unknown>).id === first.id)
      ) as Record<string, unknown> | undefined;

      return {
        ...(optionalString(parsed.requestId) === undefined ? {} : { requestId: optionalString(parsed.requestId)! }),
        title,
        url,
        ...(publishedDate === undefined ? {} : { publishedDate }),
        ...(author === undefined ? {} : { author: cap(author, 1000) }),
        ...(mode === 'text' && text !== undefined ? { text: cap(text, maxCharacters) } : {}),
        ...(mode === 'highlights' ? { highlights } : {}),
        ...(optionalString(statusItem?.status) === undefined ? {} : { status: optionalString(statusItem?.status)! }),
        ...(optionalString(statusItem?.source) === undefined ? {} : { source: optionalString(statusItem?.source)! }),
        ...(costTotal(parsed.costDollars) === undefined ? {} : { costDollars: costTotal(parsed.costDollars)! }),
      };
    },
  };
}

export function configuredExaClient(env: NodeJS.ProcessEnv = process.env): ExaClient | undefined {
  const apiKey = env.EXA_API_KEY?.trim();
  if (!apiKey) return undefined;
  return createExaClient({
    apiKey,
    ...(env.EXA_BASE_URL?.trim() ? { baseURL: env.EXA_BASE_URL.trim() } : {}),
  });
}
