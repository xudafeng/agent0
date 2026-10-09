import dotenv from 'dotenv';
import { runWakeCycle } from './background-runtime.js';
import { configuredComputerBackend } from './session-computer.js';
import { createFileSessionStore } from './session-store.js';
import { createFileWorkspaceStore } from './workspace.js';

dotenv.config({ path: '.env', override: true });

const sessions = createFileSessionStore();
const workspaces = createFileWorkspaceStore();
const backend = configuredComputerBackend(workspaces);

if (!backend) {
  console.error('No computer backend configured. Set AGENT0_COMPUTER.');
  process.exitCode = 1;
} else {
  const result = await runWakeCycle(sessions, workspaces, backend);
  console.log(JSON.stringify(result, null, 2));
  if (result.sessions.some((session) => session.error)) process.exitCode = 1;
}
