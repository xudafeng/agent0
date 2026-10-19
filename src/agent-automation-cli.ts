import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { createFileAgentAutomationStore } from './agent-automation.js';

function usage(): string {
  return [
    'Usage:',
    '  pnpm agent-automation -- create --cwd DIR --prompt TEXT (--every 12h | --cron EXPR --timezone ZONE)',
    '  pnpm agent-automation -- list',
    '  pnpm agent-automation -- status ID',
    '  pnpm agent-automation -- cancel ID',
    '  pnpm agent-automation -- enable ID',
    '',
    'Create options:',
    '  --name NAME',
    '  --cwd DIR',
    '  --skill NAME',
    '  --skill-dir DIR          Repeatable standalone skill root',
    '  --prompt TEXT',
    '  --policy read-only|trusted-workspace',
    '  --every DURATION         Examples: 30m, 12h, 1d',
    '  --cron EXPR',
    '  --timezone ZONE          IANA timezone required with --cron',
    '  --timeout DURATION        Max run duration, e.g. 2h or 6h (default: 6h)',
    '  --profile-dir DIR',
  ].join('\n');
}

function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) throw new Error('Duration must look like 30m, 12h, or 1d.');
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor = unit === 'ms' ? 1 :
    unit === 's' ? 1000 :
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
    86_400_000;
  const result = amount * factor;
  if (!Number.isFinite(result) || result <= 0) throw new Error('Duration must be positive.');
  return result;
}

function required(values: Map<string, string[]>, name: string): string {
  const value = values.get(name)?.at(-1)?.trim();
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function parseOptions(args: string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    const existing = values.get(name) ?? [];
    existing.push(value);
    values.set(name, existing);
    index += 1;
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') {
    console.log(usage());
    return;
  }

  let profileDir = resolve(process.env.AGENT0_PROFILE_DIR || process.cwd());
  if (command === 'create') {
    const options = parseOptions(args);
    const configuredProfile = options.get('profile-dir')?.at(-1);
    if (configuredProfile) profileDir = resolve(configuredProfile);
    dotenv.config({ path: join(profileDir, '.env'), override: true, quiet: true });
    const store = createFileAgentAutomationStore(join(profileDir, 'data', 'agent-automations'));

    const cwd = resolve(required(options, 'cwd'));
    const prompt = required(options, 'prompt');
    const skillName = options.get('skill')?.at(-1)?.trim();
    const explicitRoots = options.get('skill-dir') ?? [];
    const skillRoots = explicitRoots.length
      ? explicitRoots.map((root) => resolve(root))
      : skillName ? [cwd] : [];
    const policy = options.get('policy')?.at(-1)?.trim() ?? 'read-only';
    if (policy !== 'read-only' && policy !== 'trusted-workspace') {
      throw new Error('policy must be read-only or trusted-workspace.');
    }

    const every = options.get('every')?.at(-1);
    const cronExpression = options.get('cron')?.at(-1);
    const timeZone = options.get('timezone')?.at(-1);
    const timeout = options.get('timeout')?.at(-1);
    if (Boolean(every) === Boolean(cronExpression || timeZone)) {
      throw new Error('Use exactly one recurrence: --every or --cron with --timezone.');
    }
    if (cronExpression && !timeZone) throw new Error('--timezone is required with --cron.');
    if (timeZone && !cronExpression) throw new Error('--cron is required with --timezone.');

    const automation = await store.create({
      ...(options.get('name')?.at(-1)?.trim() ? { name: options.get('name')!.at(-1)!.trim() } : {}),
      prompt,
      cwd,
      ...(skillName ? { skillName } : {}),
      skillRoots,
      policy,
      ...(every ? { repeatEveryMs: parseDuration(every) } : {}),
      ...(cronExpression ? { cronExpression } : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(timeout ? { maxRunMs: parseDuration(timeout) } : {}),
    });
    console.log(JSON.stringify(automation, null, 2));
    return;
  }

  const profileFlag = args.indexOf('--profile-dir');
  if (profileFlag >= 0) {
    const value = args[profileFlag + 1];
    if (!value) throw new Error('--profile-dir requires a value.');
    profileDir = resolve(value);
    args.splice(profileFlag, 2);
  }
  dotenv.config({ path: join(profileDir, '.env'), override: true, quiet: true });
  const store = createFileAgentAutomationStore(join(profileDir, 'data', 'agent-automations'));

  if (command === 'list') {
    console.log(JSON.stringify(await store.list(), null, 2));
    return;
  }

  const id = args[0];
  if (!id) throw new Error(`${command} requires an automation ID.`);
  if (command === 'status') {
    console.log(JSON.stringify(await store.get(id), null, 2));
    return;
  }
  if (command === 'cancel') {
    console.log(JSON.stringify(await store.cancel(id), null, 2));
    return;
  }
  if (command === 'enable') {
    console.log(JSON.stringify(await store.enable(id), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
