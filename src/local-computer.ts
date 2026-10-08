import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  Computer,
  ComputerBackend,
  ComputerCapabilities,
  ComputerExecInput,
  ComputerExecResult,
  ComputerRef,
  ComputerSnapshot,
} from './computer.js';
import type { Workspace, WorkspaceStore } from './workspace.js';

const capabilities: ComputerCapabilities = {
  persistentFilesystem: true,
  persistentMemory: false,
  pauseResume: false,
  snapshot: false,
  fork: false,
  desktop: false,
};

export class LocalComputerUnsupportedError extends Error {
  constructor(operation: string) {
    super(`LocalComputer does not support ${operation}.`);
    this.name = 'LocalComputerUnsupportedError';
  }
}

export class LocalComputerTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Local command timed out after ${timeoutMs} ms.`);
    this.name = 'LocalComputerTimeoutError';
  }
}

function assertRelativePath(path: string): void {
  if (!path || isAbsolute(path)) throw new Error('Computer path must be relative to the workspace.');
}

function inside(root: string, path: string): string {
  assertRelativePath(path);
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Computer path escapes the workspace.');
  }
  return candidate;
}

function assertResolvedInside(root: string, resolved: string): void {
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Computer path escapes the workspace.');
  }
}

async function existingInside(root: string, path: string): Promise<string> {
  const candidate = inside(root, path);
  const resolved = await realpath(candidate);
  assertResolvedInside(root, resolved);
  return resolved;
}

async function writableInside(root: string, path: string): Promise<string> {
  const target = inside(root, path);
  await mkdir(dirname(target), { recursive: true });

  try {
    const resolvedTarget = await realpath(target);
    assertResolvedInside(root, resolvedTarget);
    return resolvedTarget;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const resolvedParent = await realpath(dirname(target));
  assertResolvedInside(root, resolvedParent);
  return target;
}

function validateExec(input: ComputerExecInput): void {
  if (!input.command.trim()) throw new Error('Computer command cannot be empty.');
  if (input.args?.some((arg) => typeof arg !== 'string')) throw new Error('Computer command arguments must be strings.');
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new Error('Computer timeout must be a positive number.');
  }
}

function createLocalComputer(ref: ComputerRef, filesRoot: string): Computer {
  let destroyed = false;
  const assertActive = () => {
    if (destroyed) throw new Error('LocalComputer has been destroyed.');
  };

  return {
    ref,
    capabilities,

    async exec(input, signal) {
      assertActive();
      validateExec(input);
      signal?.throwIfAborted();

      const cwd = input.cwd === undefined ? filesRoot : await existingInside(filesRoot, input.cwd);
      const timeoutController = new AbortController();
      const timeout = input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => timeoutController.abort(new LocalComputerTimeoutError(input.timeoutMs!)), input.timeoutMs);
      const combined = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        return await new Promise<ComputerExecResult>((resolvePromise, rejectPromise) => {
          const child = spawn(input.command, input.args ?? [], {
            cwd,
            env: { ...process.env, ...(input.env ?? {}) },
            shell: false,
            signal: combined,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';

          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => { stdout += chunk; });
          child.stderr.on('data', (chunk: string) => { stderr += chunk; });
          child.once('error', (error) => {
            if (combined.aborted) rejectPromise(combined.reason ?? error);
            else rejectPromise(error);
          });
          child.once('close', (code) => {
            if (combined.aborted) {
              rejectPromise(combined.reason ?? new Error('Local command aborted.'));
              return;
            }
            resolvePromise({
              exitCode: code ?? 1,
              stdout,
              stderr,
            });
          });
        });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },

    async readTextFile(path, signal) {
      assertActive();
      signal?.throwIfAborted();
      return readFile(await existingInside(filesRoot, path), 'utf8');
    },

    async writeTextFile(path, content, signal) {
      assertActive();
      signal?.throwIfAborted();
      const target = await writableInside(filesRoot, path);
      await writeFile(target, content, 'utf8');
    },

    async suspend() {
      assertActive();
      throw new LocalComputerUnsupportedError('suspend');
    },

    async resume() {
      assertActive();
      throw new LocalComputerUnsupportedError('resume');
    },

    async snapshot(): Promise<ComputerSnapshot> {
      assertActive();
      throw new LocalComputerUnsupportedError('snapshot');
    },

    async destroy() {
      destroyed = true;
    },
  };
}

export function createLocalComputerBackend(workspaces: WorkspaceStore): ComputerBackend {
  const create = async (workspace: Workspace): Promise<Computer> => {
    const stored = await workspaces.load(workspace.id);
    if (!stored) throw new Error(`Workspace not found: ${workspace.id}`);
    const root = workspaces.directory(workspace.id);
    const filesRoot = join(root, 'files');
    await mkdir(filesRoot, { recursive: true });
    return createLocalComputer({
      backend: 'local',
      id: workspace.id,
      workspaceId: workspace.id,
    }, filesRoot);
  };

  return {
    name: 'local',
    create,

    async reconnect(ref) {
      if (ref.backend !== 'local') throw new Error(`Cannot reconnect ${ref.backend} computer with local backend.`);
      if (ref.id !== ref.workspaceId) throw new Error('Invalid LocalComputer reference.');
      const workspace = await workspaces.load(ref.workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${ref.workspaceId}`);
      return create(workspace);
    },
  };
}
