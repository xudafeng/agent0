import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface Workspace {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceStore {
  create(id?: string): Promise<Workspace>;
  load(id: string): Promise<Workspace | undefined>;
  directory(id: string): string;
}

function assertWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid workspace ID.');
}

export function createFileWorkspaceStore(root = 'data/workspaces'): WorkspaceStore {
  const directory = (id: string) => {
    assertWorkspaceId(id);
    return resolve(root, id);
  };
  const metadataPath = (id: string) => join(directory(id), 'workspace.json');
  const load = async (id: string): Promise<Workspace | undefined> => {
    try {
      const content = await readFile(metadataPath(id), 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid workspace metadata.');
      const workspace = parsed as Partial<Workspace>;
      if (workspace.id !== id || typeof workspace.createdAt !== 'string' || typeof workspace.updatedAt !== 'string') {
        throw new Error('Invalid workspace metadata.');
      }
      return workspace as Workspace;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  return {
    async create(id = randomUUID()) {
      assertWorkspaceId(id);
      const existing = await load(id);
      if (existing) return existing;

      const now = new Date().toISOString();
      const workspace: Workspace = {
        id,
        createdAt: now,
        updatedAt: now,
      };
      const path = metadataPath(id);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
      await mkdir(join(directory(id), 'files'), { recursive: true });
      return workspace;
    },

    load,

    directory,
  };
}
