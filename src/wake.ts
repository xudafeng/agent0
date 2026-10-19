import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { runFullWakeCycle } from './full-wake.js';

const profileDir = resolve(process.env.AGENT0_PROFILE_DIR || process.cwd());
dotenv.config({ path: join(profileDir, '.env'), override: true, quiet: true });

const result = await runFullWakeCycle(profileDir);
console.log(JSON.stringify(result, null, 2));
if (
  result.automations.automations.some((item) => item.status === 'failed') ||
  result.background.sessions.some((session) => session.error) ||
  result.backgroundError
) {
  process.exitCode = 1;
}
