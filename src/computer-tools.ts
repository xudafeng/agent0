import { z } from 'zod';
import type { Computer, ComputerExecInput } from './computer.js';
import { getDetachedProcessStatus, readDetachedProcessOutput, startDetachedProcess } from './computer-process.js';
import type { AgentTool } from './tools.js';

const computerExecSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().finite().positive().optional(),
}).strict();

const computerReadFileSchema = z.object({
  path: z.string().trim().min(1),
}).strict();

const computerWriteFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
}).strict();

const computerStartProcessSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();

const computerProcessSchema = z.object({
  processId: z.string().trim().min(1),
}).strict();

export function createComputerTools(computer: Computer): AgentTool[] {
  const backend = computer.ref.backend;
  return [
    {
      definition: {
        name: 'computer_exec',
        description: `Run a command inside the current ${backend} computer workspace. If the backend is e2b, this command runs in the E2B sandbox. Paths are relative to the workspace unless cwd is omitted.`,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Executable or command to run.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
            cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Optional environment variables for the command.',
            },
            timeoutMs: { type: 'number', description: 'Optional positive timeout in milliseconds.' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall, context) {
        const parsed = computerExecSchema.parse(toolCall.arguments);
        const input: ComputerExecInput = {
          command: parsed.command,
          ...(parsed.args === undefined ? {} : { args: parsed.args }),
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
          ...(parsed.env === undefined ? {} : { env: parsed.env }),
          ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
        };
        return computer.exec(input, context.signal);
      },
    },
    {
      definition: {
        name: 'computer_read_file',
        description: `Read a UTF-8 text file from the current ${backend} computer workspace.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall, context) {
        const { path } = computerReadFileSchema.parse(toolCall.arguments);
        return computer.readTextFile(path, context.signal);
      },
    },
    {
      definition: {
        name: 'computer_start_process',
        description: `Start a detached background process inside the current ${backend} computer workspace. The process keeps running independently of the current agent turn and returns a stable processId for later status/output checks.`,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Executable to start.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
            cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Optional environment variables for the process.',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      execute(toolCall, context) {
        const parsed = computerStartProcessSchema.parse(toolCall.arguments);
        return startDetachedProcess(computer, {
          command: parsed.command,
          ...(parsed.args === undefined ? {} : { args: parsed.args }),
          ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
          ...(parsed.env === undefined ? {} : { env: parsed.env }),
        }, context.signal);
      },
    },
    {
      definition: {
        name: 'computer_process_status',
        description: `Check whether a detached process in the current ${backend} computer is running, completed, or no longer observable.`,
        parameters: {
          type: 'object',
          properties: {
            processId: { type: 'string', description: 'Stable process ID returned by computer_start_process.' },
          },
          required: ['processId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall, context) {
        const { processId } = computerProcessSchema.parse(toolCall.arguments);
        return getDetachedProcessStatus(computer, processId, context.signal);
      },
    },
    {
      definition: {
        name: 'computer_process_output',
        description: `Read stdout and stderr captured for a detached process in the current ${backend} computer.`,
        parameters: {
          type: 'object',
          properties: {
            processId: { type: 'string', description: 'Stable process ID returned by computer_start_process.' },
          },
          required: ['processId'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'idempotent',
      execute(toolCall, context) {
        const { processId } = computerProcessSchema.parse(toolCall.arguments);
        return readDetachedProcessOutput(computer, processId, context.signal);
      },
    },
    {
      definition: {
        name: 'computer_write_file',
        description: `Write a UTF-8 text file inside the current ${backend} computer workspace, creating parent directories when needed.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            content: { type: 'string', description: 'Complete file content to write.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      executionMode: 'sequential',
      idempotency: 'non-idempotent',
      async execute(toolCall, context) {
        const { path, content } = computerWriteFileSchema.parse(toolCall.arguments);
        await computer.writeTextFile(path, content, context.signal);
        return { path, bytes: Buffer.byteLength(content, 'utf8') };
      },
    },
  ];
}
