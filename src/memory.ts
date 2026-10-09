import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MEMORY_SCOPES = ['profile', 'preferences', 'projects', 'working', 'general'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchOptions {
  scopes?: MemoryScope[];
  limit?: number;
  maxChars?: number;
}

export interface MemoryStore {
  list(scope?: MemoryScope): Promise<MemoryEntry[]>;
  remember(content: string, scope?: MemoryScope): Promise<MemoryEntry>;
  update(id: string, content: string, scope?: MemoryScope): Promise<MemoryEntry>;
  forget(id: string): Promise<void>;
  search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  render(): Promise<string>;
}

const ENTRY_RE = /^- \[([^\]]+)\] (.*?) <!-- created:([^ ]+) updated:([^ ]+) -->$/;

function assertScope(scope: string): asserts scope is MemoryScope {
  if (!MEMORY_SCOPES.includes(scope as MemoryScope)) throw new Error(`Invalid memory scope: ${scope}`);
}

function normalizeContent(content: string): string {
  const value = content.replace(/\s+/g, ' ').trim();
  if (!value) throw new Error('Memory cannot be empty.');
  if (value.length > 4000) throw new Error('Memory cannot exceed 4000 characters.');
  return value;
}

function title(scope: MemoryScope): string {
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

function serialize(scope: MemoryScope, entries: MemoryEntry[]): string {
  const lines = entries.map((entry) =>
    `- [${entry.id}] ${entry.content} <!-- created:${entry.createdAt} updated:${entry.updatedAt} -->`
  );
  return `# ${title(scope)}\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

function parse(scope: MemoryScope, source: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of source.split('\n')) {
    const match = line.match(ENTRY_RE);
    if (!match) continue;
    const [, id, content, createdAt, updatedAt] = match;
    if (!id || !content || !createdAt || !updatedAt) continue;
    entries.push({ id, scope, content, createdAt, updatedAt });
  }
  return entries;
}

function tokenize(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function score(entry: MemoryEntry, query: string): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;
  const content = entry.content.toLocaleLowerCase();
  let value = content.includes(normalizedQuery) ? 100 : 0;
  const queryTerms = [...new Set(tokenize(normalizedQuery))];
  const contentTerms = new Set(tokenize(content));
  for (const term of queryTerms) {
    if (contentTerms.has(term)) value += Math.max(1, Math.min(20, term.length));
  }
  if (entry.scope === 'working') value += 2;
  return value;
}

export function formatMemoryEntries(entries: MemoryEntry[]): string {
  return entries.map((entry) => `- [${entry.scope}] ${entry.content}`).join('\n');
}

export function createFileMemoryStore(
  root = 'data/memory',
  legacyPath = 'data/memory.md',
): MemoryStore {
  const pathFor = (scope: MemoryScope) => join(root, `${scope}.md`);

  const readScope = async (scope: MemoryScope): Promise<MemoryEntry[]> => {
    assertScope(scope);
    try {
      return parse(scope, await readFile(pathFor(scope), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  };

  const writeScope = async (scope: MemoryScope, entries: MemoryEntry[]): Promise<void> => {
    await mkdir(root, { recursive: true });
    await writeFile(pathFor(scope), serialize(scope, entries), 'utf8');
  };

  let initialized = false;
  const initialize = async () => {
    if (initialized) return;
    initialized = true;
    await mkdir(root, { recursive: true });

    const existing = (await Promise.all(MEMORY_SCOPES.map(readScope))).flat();
    if (existing.length === 0) {
      try {
        const legacy = await readFile(legacyPath, 'utf8');
        const now = new Date().toISOString();
        const entries = legacy
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('- '))
          .map((line) => ({
            id: randomUUID(),
            scope: 'general' as const,
            content: normalizeContent(line.slice(2)),
            createdAt: now,
            updatedAt: now,
          }));
        if (entries.length) await writeScope('general', entries);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    for (const scope of MEMORY_SCOPES) {
      try {
        await readFile(pathFor(scope), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeScope(scope, []);
      }
    }
  };

  const all = async (): Promise<MemoryEntry[]> => {
    await initialize();
    return (await Promise.all(MEMORY_SCOPES.map(readScope))).flat();
  };

  return {
    async list(scope) {
      await initialize();
      const entries = scope ? await readScope(scope) : await all();
      return structuredClone(entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    },

    async remember(content, scope = 'general') {
      await initialize();
      assertScope(scope);
      const value = normalizeContent(content);
      const entries = await readScope(scope);
      const duplicate = entries.find((entry) => entry.content.toLocaleLowerCase() === value.toLocaleLowerCase());
      if (duplicate) return structuredClone(duplicate);

      const now = new Date().toISOString();
      const entry: MemoryEntry = {
        id: randomUUID(),
        scope,
        content: value,
        createdAt: now,
        updatedAt: now,
      };
      entries.push(entry);
      await writeScope(scope, entries);
      return structuredClone(entry);
    },

    async update(id, content, scope) {
      await initialize();
      const value = normalizeContent(content);
      const entries = await all();
      const existing = entries.find((entry) => entry.id === id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      const nextScope = scope ?? existing.scope;
      assertScope(nextScope);

      const source = await readScope(existing.scope);
      const sourceIndex = source.findIndex((entry) => entry.id === id);
      if (sourceIndex < 0) throw new Error(`Memory not found: ${id}`);
      source.splice(sourceIndex, 1);

      const updated: MemoryEntry = {
        ...existing,
        scope: nextScope,
        content: value,
        updatedAt: new Date().toISOString(),
      };

      if (nextScope === existing.scope) {
        source.push(updated);
        await writeScope(existing.scope, source);
      } else {
        const target = await readScope(nextScope);
        target.push(updated);
        await Promise.all([
          writeScope(existing.scope, source),
          writeScope(nextScope, target),
        ]);
      }
      return structuredClone(updated);
    },

    async forget(id) {
      await initialize();
      for (const scope of MEMORY_SCOPES) {
        const entries = await readScope(scope);
        const next = entries.filter((entry) => entry.id !== id);
        if (next.length !== entries.length) {
          await writeScope(scope, next);
          return;
        }
      }
      throw new Error(`Memory not found: ${id}`);
    },

    async search(query, options = {}) {
      await initialize();
      const scopes = options.scopes ?? [...MEMORY_SCOPES];
      const limit = options.limit ?? 12;
      const maxChars = options.maxChars ?? 4000;
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('Memory search limit must be positive.');
      if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error('Memory search character budget must be positive.');

      const entries = (await all()).filter((entry) => scopes.includes(entry.scope));
      const ranked = entries
        .map((entry) => ({ entry, score: score(entry, query) }))
        .filter((item) => !query.trim() || item.score > 0)
        .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));

      const selected: MemoryEntry[] = [];
      let used = 0;
      for (const { entry } of ranked) {
        const cost = entry.content.length + entry.scope.length + 6;
        if (selected.length >= limit || used + cost > maxChars) continue;
        selected.push(entry);
        used += cost;
      }
      return structuredClone(selected);
    },

    async render() {
      return formatMemoryEntries(await this.list());
    },
  };
}

const defaultStore = createFileMemoryStore();

export async function loadMemory(): Promise<string> {
  return defaultStore.render();
}

export async function remember(content: string): Promise<void> {
  await defaultStore.remember(content);
}
