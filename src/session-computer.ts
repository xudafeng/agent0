import type { Computer, ComputerBackend, ComputerRef } from './computer.js';
import { createE2BComputerBackend } from './e2b-computer.js';
import { createLocalComputerBackend } from './local-computer.js';
import type { WorkspaceStore } from './workspace.js';

export interface SessionComputerBinding {
  workspaceId: string;
  computerRef: ComputerRef;
}

export interface OpenSessionComputerResult {
  computer: Computer;
  binding: SessionComputerBinding;
  created: boolean;
}

export function configuredComputerBackend(
  workspaces: WorkspaceStore,
  env: NodeJS.ProcessEnv = process.env,
): ComputerBackend | undefined {
  const configured = env.AGENT0_COMPUTER?.trim().toLowerCase();
  if (!configured) return undefined;

  if (configured === 'local') {
    return createLocalComputerBackend(workspaces);
  }

  if (configured === 'e2b') {
    const apiKey = env.E2B_API_KEY?.trim();
    if (!apiKey) throw new Error('E2B_API_KEY is required when AGENT0_COMPUTER=e2b.');
    return createE2BComputerBackend({ apiKey });
  }

  throw new Error(`Unsupported computer backend: ${configured}`);
}

export async function openSessionComputer(
  backend: ComputerBackend,
  workspaces: WorkspaceStore,
  binding?: SessionComputerBinding,
): Promise<OpenSessionComputerResult> {
  if (binding) {
    if (binding.computerRef.backend !== backend.name) {
      throw new Error(
        `Session computer backend mismatch: expected ${binding.computerRef.backend}, configured ${backend.name}.`,
      );
    }
    if (binding.computerRef.workspaceId !== binding.workspaceId) {
      throw new Error('Session computer workspace mismatch.');
    }
    const workspace = await workspaces.load(binding.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${binding.workspaceId}`);
    const computer = await backend.reconnect(binding.computerRef);
    return { computer, binding: structuredClone(binding), created: false };
  }

  const workspace = await workspaces.create();
  const computer = await backend.create(workspace);
  return {
    computer,
    binding: {
      workspaceId: workspace.id,
      computerRef: structuredClone(computer.ref),
    },
    created: true,
  };
}
