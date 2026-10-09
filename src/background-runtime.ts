import type { ComputerBackend } from './computer.js';
import { reconcileDurableJobs } from './job.js';
import { createDurableScheduler } from './scheduler.js';
import type { SessionStore } from './session-store.js';
import type { WorkspaceStore } from './workspace.js';

export interface WakeSessionResult {
  sessionId: string;
  workspaceId: string;
  triggered: string[];
  nextWakeAt?: string;
  error?: string;
}

export interface WakeCycleResult {
  wokeAt: string;
  sessions: WakeSessionResult[];
  nextWakeAt?: string;
}

export async function runWakeCycle(
  sessions: SessionStore,
  workspaces: WorkspaceStore,
  backend: ComputerBackend,
  now: Date | string | number = new Date(),
): Promise<WakeCycleResult> {
  const wakeDate = new Date(now);
  if (!Number.isFinite(wakeDate.getTime())) throw new Error('Invalid wake time.');
  const summaries = await sessions.list();
  const results: WakeSessionResult[] = [];

  for (const session of summaries) {
    if (!session.workspaceId || !session.computerRef) continue;

    if (session.computerRef.backend !== backend.name) {
      results.push({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        triggered: [],
        error: `Configured computer backend ${backend.name} does not match session backend ${session.computerRef.backend}.`,
      });
      continue;
    }

    let computer;
    try {
      const workspace = await workspaces.load(session.workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${session.workspaceId}`);
      computer = await backend.reconnect(session.computerRef);
      await reconcileDurableJobs(computer);
      const scheduler = await createDurableScheduler(computer, { armTimers: false });
      try {
        const wake = await scheduler.wake(wakeDate);
        results.push({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          triggered: wake.triggered,
          ...(wake.nextWakeAt === undefined ? {} : { nextWakeAt: wake.nextWakeAt }),
        });
      } finally {
        await scheduler.close();
      }
    } catch (error) {
      results.push({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        triggered: [],
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (computer?.capabilities.pauseResume) {
        try {
          await computer.suspend();
        } catch {
          // Wake results should preserve the scheduler outcome even when
          // returning the computer to a suspended state fails.
        }
      }
    }
  }

  const nextWakeAt = results
    .map((result) => result.nextWakeAt)
    .filter((value): value is string => value !== undefined)
    .sort()[0];

  return {
    wokeAt: wakeDate.toISOString(),
    sessions: results,
    ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
  };
}
