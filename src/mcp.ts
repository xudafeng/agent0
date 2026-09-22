import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Transport, type FetchLike } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadMcpServers, type McpServerConfig } from './mcp-config.js';
import type { ToolCall, ToolDefinition } from './tools.js';

export interface McpRuntime {
  tools: ToolDefinition[];
  hasTool(name: string): boolean;
  callTool(toolCall: ToolCall, signal?: AbortSignal): Promise<unknown>;
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
  return connectServer({
    command: process.execPath,
    args: import.meta.url.endsWith('.ts')
      ? ['--import', 'tsx', fileURLToPath(new URL('./mcp-server.ts', import.meta.url))]
      : [fileURLToPath(new URL('./mcp-server.js', import.meta.url))],
    env: { ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
  });
}

function toolAlias(serverId: string, name: string): string {
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `mcp_${serverId}__${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 22)}_${hash}`;
}

async function connectServer(parameters: StdioServerParameters, serverId?: string): Promise<McpRuntime> {
  const transport = new StdioClientTransport({ ...parameters, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  return connectTransport(transport, serverId);
}

async function connectTransport(transport: Transport, serverId?: string): Promise<McpRuntime> {
  const client = new Client({ name: 'agent0', version: '0.1.0' });
  try {
    const signal = AbortSignal.timeout(15000);
    await client.connect(transport, { signal, timeout: 15000 });
    const tools: ToolDefinition[] = [];
    const names = new Map<string, string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15000 });
      for (const tool of listed.tools) {
        const name = serverId ? toolAlias(serverId, tool.name) : tool.name;
        if (names.has(name)) throw new Error('Duplicate MCP tool name.');
        names.set(name, tool.name);
        tools.push({ name, description: tool.description ?? '', parameters: tool.inputSchema as Record<string, unknown> });
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    if (cursor) throw new Error('MCP tool list exceeded 20 pages.');
    return {
      tools,
      hasTool: (name) => names.has(name),
      async callTool(toolCall, signal) {
        signal?.throwIfAborted();
        const name = names.get(toolCall.name);
        if (!name) throw new Error('Unknown MCP tool.');
        const result = await client.callTool({ name, arguments: toolCall.arguments }, { timeout: 60000, signal });
        if (result.isError) throw new Error(resultText(result.content));
        return result.content;
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
}

export function connectMcpServer(server: McpServerConfig, namespace = true): Promise<McpRuntime> {
  if ('builtin' in server) {
    return connectServer({
      command: process.execPath,
      args: [createRequire(import.meta.url).resolve('@modelcontextprotocol/server-filesystem/dist/index.js'), server.directory],
      env: { ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
      cwd: server.directory,
    }, namespace ? server.id : undefined);
  }
  if ('url' in server) {
    return connectRemoteServer(server, namespace ? server.id : undefined);
  }
  return connectServer({
    command: server.command,
    args: server.args,
    env: { ...getDefaultEnvironment(), ...server.env },
    ...(server.cwd ? { cwd: server.cwd } : {}),
  }, namespace ? server.id : undefined);
}

async function connectRemoteServer(server: Extract<McpServerConfig, { url: string }>, serverId?: string): Promise<McpRuntime> {
  const url = new URL(server.url);
  const initializationController = new AbortController();
  const initialization = initializationController.signal;
  const initializationTimer = setTimeout(() => initializationController.abort(), 15000);
  let connecting = true;
  let closing = false;
  const request: FetchLike = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== url.origin) throw new Error('MCP requests must use the configured server origin.');
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(server.headers)) headers.set(name, value);
    const requestController = new AbortController();
    const requestTimer = setTimeout(() => requestController.abort(), closing ? 3000 : 60000);
    const signals = [requestController.signal];
    if (init?.signal) signals.push(init.signal);
    if (connecting) signals.push(initialization);
    try { return await fetch(input, { ...init, headers, redirect: 'error', signal: AbortSignal.any(signals) }); }
    finally { clearTimeout(requestTimer); }
  };
  const transport = server.transport === 'http'
    ? new StreamableHTTPClientTransport(url, { fetch: request })
    : new SSEClientTransport(url, { fetch: request, eventSourceInit: { fetch: request } });
  let onTimeout: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onTimeout = () => reject(new Error('MCP connection timed out.'));
    initialization.addEventListener('abort', onTimeout, { once: true });
  });
  const closeSession = async () => {
    connecting = false;
    closing = true;
    if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession().catch(() => {});
  };
  try {
    const runtime = await Promise.race([connectTransport(transport, serverId), deadline]);
    connecting = false;
    return {
      ...runtime,
      async close() { await closeSession(); await runtime.close(); },
    };
  } catch (error) {
    await closeSession();
    await transport.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(initializationTimer);
    initialization.removeEventListener('abort', onTimeout);
  }
}

export async function checkMcpServers(servers: McpServerConfig[]) {
  return Promise.all(servers.map(async (server) => {
    if (!server.enabled) return { id: server.id, status: 'disabled' as const };
    const started = performance.now();
    let connection: McpRuntime | undefined;
    try {
      connection = await connectMcpServer(server, false);
      return {
        id: server.id, status: 'reachable' as const,
        checkedAt: Date.now(), durationMs: Math.round(performance.now() - started),
        toolCount: connection.tools.length,
      };
    } catch (error) {
      return {
        id: server.id, status: 'failed' as const, checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally { await connection?.close().catch(() => {}); }
  }));
}

export async function connectMcpServers(servers = loadMcpServers()): Promise<McpRuntime> {
  const connections = await Promise.allSettled([
    connectLocalMcpServer(),
    ...servers.filter((server) => server.enabled).map(async (server) => {
      try { return await connectMcpServer(server); }
      catch (error) { throw new Error(`MCP ${server.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }),
  ]);
  const clients = connections.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const close = async () => { await Promise.allSettled(clients.map((client) => client.close())); };
  const failed = connections.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    await close();
    throw failed.reason;
  }
  const owners = new Map(clients.flatMap((client) => client.tools.map((tool) => [tool.name, client] as const)));
  return {
    tools: clients.flatMap((client) => client.tools),
    hasTool: (name) => owners.has(name),
    async callTool(toolCall, signal) {
      signal?.throwIfAborted();
      const owner = owners.get(toolCall.name);
      if (!owner) throw new Error('Unknown MCP tool.');
      return owner.callTool(toolCall, signal);
    },
    close,
  };
}
