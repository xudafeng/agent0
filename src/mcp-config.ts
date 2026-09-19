import { isAbsolute } from 'node:path';
import { z } from 'zod';

const value = z.string().max(16384).refine((text) => !text.includes('\0'));
const serverId = z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/).refine((id) => id !== 'builtin-filesystem');
const serverSchema = z.object({
  id: serverId,
  transport: z.literal('stdio').optional(),
  command: value.refine((text) => text.trim().length > 0),
  args: z.array(value).max(128),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value).refine((env) => Object.keys(env).length <= 128),
  cwd: value.refine((text) => !text || isAbsolute(text)),
  enabled: z.boolean(),
});
const remoteSchema = z.object({
  id: serverId,
  transport: z.enum(['http', 'sse']),
  url: value.refine((text) => {
    try {
      const url = new URL(text);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
    } catch { return false; }
  }),
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), value.refine((text) => !/[\r\n]/.test(text)))
    .refine((headers) => {
      const keys = Object.keys(headers).map((key) => key.toLowerCase());
      return keys.length <= 64 && new Set(keys).size === keys.length && !keys.some((key) => ['host', 'content-length', 'connection', 'accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version'].includes(key));
    }),
  enabled: z.boolean(),
});
const filesystemSchema = z.object({
  id: z.literal('builtin-filesystem'),
  builtin: z.literal('filesystem'),
  directory: value.refine((text) => isAbsolute(text)),
  enabled: z.boolean(),
});
const serversSchema = z.array(z.union([filesystemSchema, remoteSchema, serverSchema])).max(16).refine((servers) => new Set(servers.map((server) => server.id)).size === servers.length);

export type McpServerConfig = z.infer<typeof serverSchema> | z.infer<typeof filesystemSchema> | z.infer<typeof remoteSchema>;
export const mcpConfigKey = 'MCP_SERVERS_BASE64';

export function validateMcpServers(input: unknown): McpServerConfig[] {
  const parsed = serversSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid MCP configuration. Check IDs, transport settings, URLs, headers, and directories.');
  return parsed.data;
}

export function loadMcpServers(encoded = process.env[mcpConfigKey]): McpServerConfig[] {
  if (!encoded) return [];
  try {
    return validateMcpServers(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
  } catch {
    throw new Error('Could not read MCP configuration from .env.');
  }
}

export function encodeMcpServers(input: unknown): string {
  return Buffer.from(JSON.stringify(validateMcpServers(input))).toString('base64');
}
