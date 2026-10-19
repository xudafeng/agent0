import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { runFullWakeCycle } from './full-wake.js';

const profileDir = resolve(process.env.AGENT0_PROFILE_DIR || process.cwd());
dotenv.config({ path: join(profileDir, '.env'), override: true, quiet: true });

const controller = new AbortController();
const stop = () => controller.abort(new Error('Agent worker stopped.'));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

function delayUntil(nextWakeAt: string | undefined): number {
  const MAX_POLL_MS = 60_000;
  const MIN_DELAY_MS = 250;
  if (!nextWakeAt) return MAX_POLL_MS;
  const delay = new Date(nextWakeAt).getTime() - Date.now();
  if (!Number.isFinite(delay)) return MAX_POLL_MS;
  return Math.max(MIN_DELAY_MS, Math.min(delay, MAX_POLL_MS));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const finish = (action: () => void) => {
      signal.removeEventListener('abort', abort);
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => finish(resolveSleep), ms);
    const abort = () => finish(() => rejectSleep(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
  });
}

try {
  while (!controller.signal.aborted) {
    const result = await runFullWakeCycle(profileDir);
    console.log(JSON.stringify(result));
    await sleep(delayUntil(result.nextWakeAt), controller.signal);
  }
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
