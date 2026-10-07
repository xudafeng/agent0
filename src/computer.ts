import type { Workspace } from './workspace.js';

export interface ComputerCapabilities {
  persistentFilesystem: boolean;
  persistentMemory: boolean;
  pauseResume: boolean;
  snapshot: boolean;
  fork: boolean;
  desktop: boolean;
}

export interface ComputerRef {
  backend: string;
  id: string;
  workspaceId: string;
}

export interface ComputerExecInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ComputerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ComputerSnapshot {
  id: string;
  computerId: string;
  createdAt: string;
}

export interface Computer {
  readonly ref: ComputerRef;
  readonly capabilities: ComputerCapabilities;

  exec(input: ComputerExecInput, signal?: AbortSignal): Promise<ComputerExecResult>;
  readTextFile(path: string, signal?: AbortSignal): Promise<string>;
  writeTextFile(path: string, content: string, signal?: AbortSignal): Promise<void>;

  suspend(): Promise<void>;
  resume(): Promise<void>;
  snapshot(): Promise<ComputerSnapshot>;
  destroy(): Promise<void>;
}

export interface ComputerBackend {
  readonly name: string;
  create(workspace: Workspace): Promise<Computer>;
  reconnect(ref: ComputerRef): Promise<Computer>;
}
