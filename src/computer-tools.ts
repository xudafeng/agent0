import { z } from 'zod';
import type { Computer } from './computer.js';
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
        const input = computerExecSchema.parse(toolCall.arguments);
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
