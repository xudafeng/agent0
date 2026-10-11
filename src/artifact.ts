import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export interface AgentArtifact {
  id: string;
  title: string;
  kind: 'markdown' | 'text' | 'json';
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactStore {
  create(input: { title: string; kind?: AgentArtifact['kind']; content: string }): Promise<AgentArtifact>;
  list(): Promise<AgentArtifact[]>;
  read(id: string): Promise<{ artifact: AgentArtifact; content: string }>;
}

const artifactSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['markdown', 'text', 'json']),
  path: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

function normalizeTitle(value: string): string {
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('Artifact title cannot be empty.');
  if (title.length > 500) throw new Error('Artifact title is too long.');
  return title;
}

export function createFileArtifactStore(root = 'data/artifacts'): ArtifactStore {
  const indexPath = join(root, 'index.json');

  const readIndex = async (): Promise<AgentArtifact[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Invalid artifact index.');
      return parsed.map((item) => artifactSchema.parse(item) as AgentArtifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  };

  const saveIndex = async (items: AgentArtifact[]) => {
    await mkdir(dirname(indexPath), { recursive: true });
    const temporary = `${indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    await rename(temporary, indexPath);
  };

  return {
    async create(input) {
      const kind = input.kind ?? 'markdown';
      if (!input.content.trim()) throw new Error('Artifact content cannot be empty.');
      const id = randomUUID();
      const extension = kind === 'markdown' ? 'md' : kind === 'json' ? 'json' : 'txt';
      const path = join(root, 'files', `${id}.${extension}`);
      const now = new Date().toISOString();
      const artifact: AgentArtifact = {
        id,
        title: normalizeTitle(input.title),
        kind,
        path,
        createdAt: now,
        updatedAt: now,
      };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content, 'utf8');
      const index = await readIndex();
      index.unshift(artifact);
      await saveIndex(index);
      return structuredClone(artifact);
    },

    async list() {
      return structuredClone(await readIndex());
    },

    async read(id) {
      const index = await readIndex();
      const artifact = index.find((item) => item.id === id);
      if (!artifact) throw new Error(`Artifact not found: ${id}`);
      return {
        artifact: structuredClone(artifact),
        content: await readFile(artifact.path, 'utf8'),
      };
    },
  };
}
