import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { runHeadlessAgent, type HeadlessPolicy } from './agent-run.js';
import { createFileAgentRunStore } from './agent-run-store.js';

interface CliOptions {
  profileDir: string;
  prompt?: string;
  promptFile?: string;
  cwd?: string;
  skillName?: string;
  skillRoots: string[];
  sessionId?: string;
  policy: HeadlessPolicy;
  trigger: 'manual' | 'scheduled';
  resumeAgentRunId?: string;
  statusId?: string;
  list: boolean;
  json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm agent-run -- --prompt "..." [--cwd DIR] [--skill NAME] [--skill-dir DIR]',
    '  pnpm agent-run -- --resume-agent-run ID',
    '  pnpm agent-run -- --status ID',
    '  pnpm agent-run -- --list',
    '',
    'Options:',
    '  --profile-dir DIR         Agent0 profile containing .env and data/ (default: AGENT0_PROFILE_DIR or cwd)',
    '  --cwd DIR                 Trusted local working directory exposed as the Computer workspace',
    '  --skill NAME              Preload one skill before the run',
    '  --skill-dir DIR           Standalone skill root containing SKILL.md; repeatable',
    '  --session ID              Continue a prior headless session',
    '  --prompt TEXT             Prompt to run',
    '  --prompt-file FILE        Read the prompt from a UTF-8 file',
    '  --policy POLICY           read-only or trusted-workspace (default: read-only)',
    '  --trigger TRIGGER         manual or scheduled (default: manual)',
    '  --resume-agent-run ID     Resume a crashed running AgentRun from its runtime checkpoint',
    '  --status ID               Print one AgentRun record',
    '  --list                    List recent AgentRun records',
    '  --json                    Print machine-readable JSON only',
    '  --help                    Show this help',
  ].join('\n');
}

function valueAfter(argv: string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    profileDir: resolve(process.env.AGENT0_PROFILE_DIR || process.cwd()),
    skillRoots: [],
    policy: 'read-only',
    trigger: 'manual',
    list: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--profile-dir') {
      options.profileDir = resolve(valueAfter(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--prompt') {
      options.prompt = valueAfter(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--prompt-file') {
      options.promptFile = resolve(valueAfter(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--cwd') {
      options.cwd = resolve(valueAfter(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--skill') {
      options.skillName = valueAfter(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--skill-dir') {
      options.skillRoots.push(resolve(valueAfter(argv, index, arg)));
      index += 1;
      continue;
    }
    if (arg === '--session') {
      options.sessionId = valueAfter(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--policy') {
      const policy = valueAfter(argv, index, arg);
      if (policy !== 'read-only' && policy !== 'trusted-workspace') {
        throw new Error('policy must be read-only or trusted-workspace.');
      }
      options.policy = policy;
      index += 1;
      continue;
    }
    if (arg === '--trigger') {
      const trigger = valueAfter(argv, index, arg);
      if (trigger !== 'manual' && trigger !== 'scheduled') {
        throw new Error('trigger must be manual or scheduled.');
      }
      options.trigger = trigger;
      index += 1;
      continue;
    }
    if (arg === '--resume-agent-run') {
      options.resumeAgentRunId = valueAfter(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--status') {
      options.statusId = valueAfter(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  dotenv.config({ path: join(options.profileDir, '.env'), override: true, quiet: true });
  const store = createFileAgentRunStore(join(options.profileDir, 'data', 'agent-runs'));

  if (options.list) {
    const runs = await store.list();
    console.log(JSON.stringify(runs.slice(0, 50), null, 2));
    return;
  }

  if (options.statusId) {
    const record = await store.load(options.statusId);
    if (!record) throw new Error(`Agent run not found: ${options.statusId}`);
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  let prompt = options.prompt;
  if (options.promptFile) {
    if (prompt !== undefined) throw new Error('Use either --prompt or --prompt-file, not both.');
    prompt = await readFile(options.promptFile, 'utf8');
  }

  const skillRoots = options.skillRoots.length
    ? options.skillRoots
    : options.skillName && options.cwd ? [options.cwd] : [];

  if (options.policy === 'trusted-workspace' && !options.json) {
    console.error('Headless policy: trusted-workspace (non-interactive tool mutations are allowed).');
  }

  const result = await runHeadlessAgent({
    profileDir: options.profileDir,
    ...(prompt === undefined ? {} : { prompt }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.skillName === undefined ? {} : { skillName: options.skillName }),
    skillRoots,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    policy: options.policy,
    trigger: options.trigger,
    ...(options.resumeAgentRunId === undefined ? {} : { resumeAgentRunId: options.resumeAgentRunId }),
    onEvent: options.json ? undefined : (event) => {
      if (event.type === 'run_start') console.error(`Run ${event.runId} started.`);
      if (event.type === 'tool_start') console.error(`→ ${event.toolCall.name}`);
      if (event.type === 'tool_end') console.error(`${event.isError ? '!' : '✓'} ${event.name}`);
      if (event.type === 'run_resumed') console.error(`Run resumed from step ${event.fromStep}.`);
    },
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.text);
    console.error(`AgentRun: ${result.record.agentRunId} | RuntimeRun: ${result.record.runtimeRunId} | steps: ${result.steps}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
