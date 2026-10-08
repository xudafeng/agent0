import { posix } from 'node:path';
import { Sandbox } from 'e2b';
import type {
  Computer,
  ComputerBackend,
  ComputerCapabilities,
  ComputerExecInput,
  ComputerRef,
  ComputerSnapshot,
} from './computer.js';
import type { Workspace } from './workspace.js';

const capabilities: ComputerCapabilities = {
  persistentFilesystem: true,
  persistentMemory: true,
  pauseResume: true,
  snapshot: false,
  fork: false,
  desktop: false,
};

export class E2BComputerUnsupportedError extends Error {
  constructor(operation: string) {
    super(`E2BComputer does not support ${operation} through the current Agent0 contract.`);
    this.name = 'E2BComputerUnsupportedError';
  }
}

interface E2BCommandResultLike {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface E2BSandboxLike {
  sandboxId: string;
  commands: {
    run(command: string, options?: {
      cwd?: string;
      envs?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<E2BCommandResultLike>;
  };
  files: {
    read(path: string, options?: { signal?: AbortSignal }): Promise<string>;
    write(path: string, content: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
  pause(options?: { keepMemory?: boolean }): Promise<boolean>;
  connect(): Promise<unknown>;
  kill(): Promise<boolean>;
}

export interface E2BComputerBackendOptions {
  template?: string;
  sandboxTimeoutMs?: number;
  apiKey?: string;
  root?: string;
  createSandbox?: (workspace: Workspace) => Promise<E2BSandboxLike>;
  connectSandbox?: (sandboxId: string) => Promise<E2BSandboxLike>;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid workspace ID.');
}

function commandLine(input: ComputerExecInput): string {
  if (!input.command.trim()) throw new Error('Computer command cannot be empty.');
  if (input.args?.some((arg) => typeof arg !== 'string')) throw new Error('Computer command arguments must be strings.');
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new Error('Computer timeout must be a positive number.');
  }
  return [input.command, ...(input.args ?? [])].map(quote).join(' ');
}

function relativePath(path: string): string {
  if (!path || posix.isAbsolute(path)) {
    throw new Error('Computer path must be relative to the workspace.');
  }
  const normalized = posix.normalize(path);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Computer path escapes the workspace.');
  }
  return normalized;
}

function createE2BComputer(
  sandbox: E2BSandboxLike,
  workspaceId: string,
  root: string,
): Computer {
  let destroyed = false;
  const ref: ComputerRef = {
    backend: 'e2b',
    id: sandbox.sandboxId,
    workspaceId,
  };
  assertWorkspaceId(workspaceId);
  const workspaceRoot = posix.join(root, workspaceId);

  const assertActive = () => {
    if (destroyed) throw new Error('E2BComputer has been destroyed.');
  };

  const pathInWorkspace = (path: string) => posix.join(workspaceRoot, relativePath(path));

  return {
    ref,
    capabilities,

    async exec(input, signal) {
      assertActive();
      signal?.throwIfAborted();
      const result = await sandbox.commands.run(commandLine(input), {
        cwd: input.cwd === undefined ? workspaceRoot : pathInWorkspace(input.cwd),
        ...(input.env ? { envs: input.env } : {}),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(signal ? { signal } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },

    async readTextFile(path, signal) {
      assertActive();
      signal?.throwIfAborted();
      return sandbox.files.read(pathInWorkspace(path), signal ? { signal } : undefined);
    },

    async writeTextFile(path, content, signal) {
      assertActive();
      signal?.throwIfAborted();
      const target = pathInWorkspace(path);
      const parent = posix.dirname(target);
      await sandbox.commands.run(`mkdir -p ${quote(parent)}`, signal ? { signal } : undefined);
      await sandbox.files.write(target, content, signal ? { signal } : undefined);
    },

    async suspend() {
      assertActive();
      await sandbox.pause({ keepMemory: true });
    },

    async resume() {
      assertActive();
      await sandbox.connect();
    },

    async snapshot(): Promise<ComputerSnapshot> {
      assertActive();
      throw new E2BComputerUnsupportedError('snapshot');
    },

    async destroy() {
      if (destroyed) return;
      await sandbox.kill();
      destroyed = true;
    },
  };
}

export function createE2BComputerBackend(options: E2BComputerBackendOptions = {}): ComputerBackend {
  const root = options.root ?? '/home/user/agent0';

  const createSandbox = options.createSandbox ?? (async (workspace: Workspace) => {
    const createOptions = {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.sandboxTimeoutMs === undefined ? {} : { timeoutMs: options.sandboxTimeoutMs }),
      metadata: { agent0WorkspaceId: workspace.id },
      lifecycle: { onTimeout: { action: 'pause' as const, keepMemory: true } },
    };
    return options.template
      ? Sandbox.create(options.template, createOptions)
      : Sandbox.create(createOptions);
  });

  const connectSandbox = options.connectSandbox ?? (async (sandboxId: string) => Sandbox.connect(
    sandboxId,
    options.apiKey ? { apiKey: options.apiKey } : undefined,
  ));

  return {
    name: 'e2b',

    async create(workspace) {
      const sandbox = await createSandbox(workspace);
      const workspaceRoot = posix.join(root, workspace.id);
      await sandbox.commands.run(`mkdir -p ${quote(workspaceRoot)}`);
      return createE2BComputer(sandbox, workspace.id, root);
    },

    async reconnect(ref) {
      if (ref.backend !== 'e2b') throw new Error(`Cannot reconnect ${ref.backend} computer with E2B backend.`);
      if (!ref.id || !ref.workspaceId) throw new Error('Invalid E2BComputer reference.');
      const sandbox = await connectSandbox(ref.id);
      return createE2BComputer(sandbox, ref.workspaceId, root);
    },
  };
}
