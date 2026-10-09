import { randomUUID } from 'node:crypto';
import type { Computer } from './computer.js';
import {
  getDetachedProcessStatus,
  readDetachedProcessOutput,
  startDetachedProcess,
  type DetachedProcessStartInput,
} from './computer-process.js';

export type DurableJobState = 'starting' | 'running' | 'succeeded' | 'failed' | 'unknown';

export interface DurableJob {
  jobId: string;
  state: DurableJobState;
  processId?: string;
  exitCode?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DurableJobOutput {
  jobId: string;
  stdout: string;
  stderr: string;
}

interface JobIndex {
  version: 1;
  jobs: DurableJob[];
}

const JOB_INDEX_PATH = '.agent0/jobs/index.json';

function assertJobId(jobId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error('Invalid job ID.');
}

function jobPath(jobId: string): string {
  assertJobId(jobId);
  return `.agent0/jobs/${jobId}.json`;
}

async function loadJobIndex(computer: Computer, signal?: AbortSignal): Promise<JobIndex> {
  const probe = await computer.exec({
    command: 'sh',
    args: ['-lc', `if [ -f '${JOB_INDEX_PATH}' ]; then printf exists; else printf missing; fi`],
  }, signal);
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'exists') {
    return { version: 1, jobs: [] };
  }

  const parsed: unknown = JSON.parse(await computer.readTextFile(JOB_INDEX_PATH, signal));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid durable job index.');
  const index = parsed as Partial<JobIndex>;
  if (index.version !== 1 || !Array.isArray(index.jobs)) throw new Error('Invalid durable job index.');
  return {
    version: 1,
    jobs: index.jobs.map((job) => validateJob(job, (job as DurableJob).jobId)),
  };
}

async function saveJob(computer: Computer, job: DurableJob, signal?: AbortSignal): Promise<void> {
  await computer.writeTextFile(jobPath(job.jobId), `${JSON.stringify(job, null, 2)}\n`, signal);
  const index = await loadJobIndex(computer, signal);
  const existing = index.jobs.findIndex((item) => item.jobId === job.jobId);
  if (existing >= 0) index.jobs[existing] = structuredClone(job);
  else index.jobs.unshift(structuredClone(job));
  await computer.writeTextFile(JOB_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, signal);
}

function validateJob(parsed: unknown, jobId: string): DurableJob {
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid durable job metadata.');
  const job = parsed as Partial<DurableJob>;
  if (job.jobId !== jobId || typeof job.createdAt !== 'string' ||
      !['starting', 'running', 'succeeded', 'failed', 'unknown'].includes(job.state ?? '')) {
    throw new Error('Invalid durable job metadata.');
  }
  if (job.processId !== undefined && typeof job.processId !== 'string') {
    throw new Error('Invalid durable job metadata.');
  }
  if (job.exitCode !== undefined && !Number.isInteger(job.exitCode)) {
    throw new Error('Invalid durable job metadata.');
  }
  return job as DurableJob;
}

export async function loadDurableJob(
  computer: Computer,
  jobId: string,
  signal?: AbortSignal,
): Promise<DurableJob> {
  const content = await computer.readTextFile(jobPath(jobId), signal);
  return validateJob(JSON.parse(content) as unknown, jobId);
}

export async function startDurableJob(
  computer: Computer,
  input: DetachedProcessStartInput,
  signal?: AbortSignal,
): Promise<DurableJob> {
  signal?.throwIfAborted();
  const now = new Date().toISOString();
  const job: DurableJob = {
    jobId: randomUUID(),
    state: 'starting',
    createdAt: now,
  };
  await saveJob(computer, job, signal);

  const process = await startDetachedProcess(computer, input, signal);
  const running: DurableJob = {
    ...job,
    state: 'running',
    processId: process.processId,
    startedAt: new Date().toISOString(),
  };
  await saveJob(computer, running, signal);
  return running;
}

export async function getDurableJobStatus(
  computer: Computer,
  jobId: string,
  signal?: AbortSignal,
): Promise<DurableJob> {
  const job = await loadDurableJob(computer, jobId, signal);
  if (!job.processId || job.state === 'succeeded' || job.state === 'failed') return job;

  const process = await getDetachedProcessStatus(computer, job.processId, signal);
  if (process.state === 'running') {
    if (job.state === 'running') return job;
    const running = { ...job, state: 'running' as const };
    await saveJob(computer, running, signal);
    return running;
  }

  if (process.state === 'completed') {
    const exitCode = process.exitCode;
    if (exitCode === undefined) throw new Error('Completed process is missing an exit code.');
    const completed: DurableJob = {
      ...job,
      state: exitCode === 0 ? 'succeeded' : 'failed',
      exitCode,
      completedAt: job.completedAt ?? new Date().toISOString(),
    };
    await saveJob(computer, completed, signal);
    return completed;
  }

  const unknown: DurableJob = { ...job, state: 'unknown' };
  await saveJob(computer, unknown, signal);
  return unknown;
}

export async function readDurableJobOutput(
  computer: Computer,
  jobId: string,
  signal?: AbortSignal,
): Promise<DurableJobOutput> {
  const job = await loadDurableJob(computer, jobId, signal);
  if (!job.processId) throw new Error('Durable job has not started a process yet.');
  const output = await readDetachedProcessOutput(computer, job.processId, signal);
  return {
    jobId,
    stdout: output.stdout,
    stderr: output.stderr,
  };
}


export async function listDurableJobs(
  computer: Computer,
  signal?: AbortSignal,
): Promise<DurableJob[]> {
  return structuredClone((await loadJobIndex(computer, signal)).jobs);
}

export async function reconcileDurableJobs(
  computer: Computer,
  signal?: AbortSignal,
): Promise<DurableJob[]> {
  const jobs = await listDurableJobs(computer, signal);
  const reconciled: DurableJob[] = [];
  for (const job of jobs) {
    if (job.state === 'running' || job.state === 'starting' || job.state === 'unknown') {
      reconciled.push(await getDurableJobStatus(computer, job.jobId, signal));
    } else {
      reconciled.push(job);
    }
  }
  return reconciled;
}
