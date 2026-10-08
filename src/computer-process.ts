import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Computer, ComputerExecInput } from './computer.js';

export interface DetachedProcessStartInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface DetachedProcessHandle {
  processId: string;
}

export interface DetachedProcessStatus {
  processId: string;
  state: 'running' | 'completed' | 'unknown';
  exitCode?: number;
}

export interface DetachedProcessOutput {
  processId: string;
  stdout: string;
  stderr: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertProcessId(processId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(processId)) {
    throw new Error('Invalid computer process ID.');
  }
}

function assertRelativeCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  if (!cwd || posix.isAbsolute(cwd)) throw new Error('Computer process cwd must be workspace-relative.');
  const normalized = posix.normalize(cwd);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Computer process cwd escapes the workspace.');
  }
  return normalized === '.' ? undefined : normalized;
}

function processDirectory(processId: string): string {
  assertProcessId(processId);
  return `.agent0/processes/${processId}`;
}

function processPath(processId: string, filename: string): string {
  return posix.join(processDirectory(processId), filename);
}

function commandLine(input: DetachedProcessStartInput): string {
  if (!input.command.trim()) throw new Error('Computer process command cannot be empty.');
  return [input.command, ...(input.args ?? [])].map(quote).join(' ');
}

function relativeFromCwd(cwd: string | undefined, target: string): string {
  return posix.relative(cwd ?? '.', target) || '.';
}

export async function startDetachedProcess(
  computer: Computer,
  input: DetachedProcessStartInput,
  signal?: AbortSignal,
): Promise<DetachedProcessHandle> {
  signal?.throwIfAborted();
  const cwd = assertRelativeCwd(input.cwd);
  const processId = randomUUID();
  const stdoutPath = processPath(processId, 'stdout.log');
  const stderrPath = processPath(processId, 'stderr.log');
  const exitPath = processPath(processId, 'exit-code');
  const pidPath = processPath(processId, 'pid');

  await computer.writeTextFile(stdoutPath, '', signal);
  await computer.writeTextFile(stderrPath, '', signal);

  // Validate the working directory through the Computer boundary before the
  // shell starts a detached child from it.
  if (cwd !== undefined) {
    await computer.exec({ command: 'pwd', cwd }, signal);
  }

  const stdoutFromCwd = relativeFromCwd(cwd, stdoutPath);
  const stderrFromCwd = relativeFromCwd(cwd, stderrPath);
  const exitFromCwd = relativeFromCwd(cwd, exitPath);
  const wrapped = `${commandLine(input)}; code=$?; printf '%s' "$code" > ${quote(exitFromCwd)}`;
  const launcher = [
    `: > ${quote(stdoutFromCwd)}`,
    `: > ${quote(stderrFromCwd)}`,
    `nohup sh -lc ${quote(wrapped)} > ${quote(stdoutFromCwd)} 2> ${quote(stderrFromCwd)} < /dev/null &`,
    `printf '%s' "$!"`,
  ].join('; ');

  const execInput: ComputerExecInput = {
    command: 'sh',
    args: ['-lc', launcher],
    ...(cwd === undefined ? {} : { cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
  };
  const result = await computer.exec(execInput, signal);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to start detached computer process: ${result.stderr || result.stdout}`);
  }

  const pid = result.stdout.trim();
  if (!/^\d+$/.test(pid)) {
    throw new Error('Detached computer process did not return a valid PID.');
  }
  await computer.writeTextFile(pidPath, pid, signal);
  return { processId };
}

export async function getDetachedProcessStatus(
  computer: Computer,
  processId: string,
  signal?: AbortSignal,
): Promise<DetachedProcessStatus> {
  signal?.throwIfAborted();
  const exitPath = processPath(processId, 'exit-code');
  const completed = await computer.exec({
    command: 'sh',
    args: ['-lc', `if [ -f ${quote(exitPath)} ]; then cat ${quote(exitPath)}; else exit 44; fi`],
  }, signal);

  if (completed.exitCode === 0) {
    const exitCode = Number.parseInt(completed.stdout.trim(), 10);
    if (!Number.isInteger(exitCode)) throw new Error('Invalid detached process exit code.');
    return { processId, state: 'completed', exitCode };
  }

  const pid = (await computer.readTextFile(processPath(processId, 'pid'), signal)).trim();
  if (!/^\d+$/.test(pid)) throw new Error('Invalid detached process PID.');
  const running = await computer.exec({ command: 'kill', args: ['-0', pid] }, signal);
  return {
    processId,
    state: running.exitCode === 0 ? 'running' : 'unknown',
  };
}

export async function readDetachedProcessOutput(
  computer: Computer,
  processId: string,
  signal?: AbortSignal,
): Promise<DetachedProcessOutput> {
  signal?.throwIfAborted();
  return {
    processId,
    stdout: await computer.readTextFile(processPath(processId, 'stdout.log'), signal),
    stderr: await computer.readTextFile(processPath(processId, 'stderr.log'), signal),
  };
}
