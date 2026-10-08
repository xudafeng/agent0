import type { Computer } from './computer.js';
import type { AgentTool, ToolCall } from './tools.js';

function stringArg(toolCall: ToolCall, name: string): string {
  const value = toolCall.arguments[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Computer tool requires non-empty string argument: ${name}`);
  }
  return value;
}

function optionalStringArg(toolCall: ToolCall, name: string): string | undefined {
  const value = toolCall.arguments[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Computer tool argument must be a non-empty string: ${name}`);
  }
  return value;
}

function stringArrayArg(toolCall: ToolCall, name: string): string[] | undefined {
  const value = toolCall.arguments[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Computer tool argument must be an array of strings: ${name}`);
  }
  return value;
}

function stringRecordArg(toolCall: ToolCall, name: string): Record<string, string> | undefined {
  const value = toolCall.arguments[name];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error(`Computer tool argument must be an object of string values: ${name}`);
  }
  return value as Record<string, string>;
}

function positiveNumberArg(toolCall: ToolCall, name: string): number | undefined {
  const value = toolCall.arguments[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Computer tool argument must be a positive number: ${name}`);
  }
  return value;
}

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
      async execute(toolCall, context) {
        const command = stringArg(toolCall, 'command');
        const args = stringArrayArg(toolCall, 'args');
        const cwd = optionalStringArg(toolCall, 'cwd');
        const env = stringRecordArg(toolCall, 'env');
        const timeoutMs = positiveNumberArg(toolCall, 'timeoutMs');
        return computer.exec({
          command,
          ...(args === undefined ? {} : { args }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(env === undefined ? {} : { env }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }, context.signal);
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
        return computer.readTextFile(stringArg(toolCall, 'path'), context.signal);
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
        const path = stringArg(toolCall, 'path');
        const content = toolCall.arguments.content;
        if (typeof content !== 'string') throw new Error('Computer tool requires string argument: content');
        await computer.writeTextFile(path, content, context.signal);
        return { path, bytes: Buffer.byteLength(content, 'utf8') };
      },
    },
  ];
}
