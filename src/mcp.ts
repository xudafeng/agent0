import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import type { ToolCall, ToolDefinition } from './tools.js';

export interface McpRuntime {
  tools: ToolDefinition[];
  hasTool(name: string): boolean;
  callTool(toolCall: ToolCall): Promise<unknown>;
  close(): Promise<void>;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }

  return content
    .map((block) => {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
        return String(block.text);
      }
      return JSON.stringify(block);
    })
    .join('\n');
}

export async function connectLocalMcpServer(): Promise<McpRuntime> {
  const client = new Client({ name: 'agent0', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: import.meta.url.endsWith('.ts')
      ? ['--import', 'tsx', fileURLToPath(new URL('./mcp-server.ts', import.meta.url))]
      : [fileURLToPath(new URL('./mcp-server.js', import.meta.url))],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ELECTRON_RUN_AS_NODE: '1' },
  });

  await client.connect(transport);

  const listed = await client.listTools();
  const tools: ToolDefinition[] = listed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema as Record<string, unknown>,
  }));
  const names = new Set(tools.map((tool) => tool.name));

  return {
    tools,
    hasTool(name) {
      return names.has(name);
    },
    async callTool(toolCall) {
      const result = await client.callTool({
        name: toolCall.name,
        arguments: toolCall.arguments,
      });

      if (result.isError) {
        throw new Error(resultText(result.content));
      }

      return result.content;
    },
    async close() {
      await client.close();
    },
  };
}
