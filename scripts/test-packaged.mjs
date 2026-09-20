import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/test-packaged.mjs <application executable>');
const result = spawnSync(resolve(executable), ['--agent0-smoke-test'], {
  encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (result.status !== 0 || !result.stdout.includes('PASS: packaged application')) {
  throw new Error(`Packaged application failed: status=${result.status}, signal=${result.signal}`);
}
