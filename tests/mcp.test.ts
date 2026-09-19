import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMcpServers, connectMcpServer, connectMcpServers } from '../src/mcp.js';
import { encodeMcpServers, loadMcpServers, validateMcpServers, type McpServerConfig } from '../src/mcp-config.js';

const server: McpServerConfig = {
  id: 'example',
  command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('../src/mcp-server.ts', import.meta.url))],
  cwd: process.cwd(),
  env: {},
  enabled: true,
};

test('MCP configuration round trips special characters and rejects invalid or duplicate servers', () => {
  const config = [{ ...server, env: { TOKEN: 'quotes\'"`#\n中文' } }];
  assert.deepEqual(loadMcpServers(encodeMcpServers(config)), config);
  assert.deepEqual(loadMcpServers(''), []);
  for (const invalid of [
    [server, server], [{ ...server, id: 'bad id' }], [{ ...server, command: '' }],
    [{ ...server, args: 'not-an-array' }], [{ ...server, env: { TOKEN: 42 } }],
    [{ ...server, cwd: './relative' }], [{ ...server, enabled: 'yes' }],
  ]) assert.throws(() => validateMcpServers(invalid), /Invalid MCP configuration/);
  assert.throws(() => loadMcpServers('invalid'), /Could not read MCP configuration/);
});

test('multiple MCP servers route duplicate tool names and skip disabled servers', async () => {
  const runtime = await connectMcpServers([
    server,
    { ...server, id: 'second' },
    { ...server, id: 'disabled', command: '/missing/executable', enabled: false },
  ]);
  try {
    assert.equal(runtime.tools.length, 3);
    assert.equal(new Set(runtime.tools.map((tool) => tool.name)).size, 3);
    for (const tool of runtime.tools) {
      assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
      const result = await runtime.callTool({ id: 'test', name: tool.name, arguments: { name: tool.name } });
      assert.deepEqual(result, [{ type: 'text', text: `Hello, ${tool.name}!` }]);
    }
    await assert.rejects(runtime.callTool({ id: 'missing', name: 'missing', arguments: {} }), /Unknown MCP tool/);
  } finally { await runtime.close(); }
});

test('connection testing exposes original tool names and reports missing executables', async () => {
  const runtime = await connectMcpServer(server, false);
  try { assert.deepEqual(runtime.tools.map((tool) => tool.name), ['greet']); }
  finally { await runtime.close(); }
  await assert.rejects(connectMcpServer({ ...server, command: '/missing/executable' }), /ENOENT/);
  await assert.rejects(connectMcpServers([server, { ...server, id: 'broken', command: '/missing/executable' }]), /MCP broken:/);
});

test('connectivity checks isolate failures and do not launch disabled servers', async () => {
  const results = await checkMcpServers([
    server,
    { ...server, id: 'broken', command: '/missing/executable' },
    { ...server, id: 'disabled', command: '/missing/executable', enabled: false },
  ]);
  assert.deepEqual(results.map((result) => result.status), ['reachable', 'failed', 'disabled']);
  assert.equal(results[0]?.toolCount, 1);
  assert.ok(typeof results[0]?.durationMs === 'number');
  assert.ok(typeof results[0]?.checkedAt === 'number');
  assert.match(results[1]?.error || '', /ENOENT/);
  assert.equal(results[2]?.checkedAt, undefined);
  assert.deepEqual(await checkMcpServers([]), []);
});

test('bundled filesystem reads and writes only within its selected directory', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'agent0-filesystem-')));
  const directory = join(temporary, 'allowed');
  await mkdir(directory);
  const outside = join(temporary, 'outside.txt');
  await writeFile(outside, 'outside content');
  await symlink(outside, join(directory, 'escape.txt'));
  const config: McpServerConfig = { id: 'builtin-filesystem', builtin: 'filesystem', directory, enabled: true };
  assert.deepEqual(loadMcpServers(encodeMcpServers([config])), [config]);
  assert.throws(() => validateMcpServers([{ ...config, directory: '' }]), /Invalid MCP/);
  assert.throws(() => validateMcpServers([{ ...server, id: 'builtin-filesystem' }]), /Invalid MCP/);
  const runtime = await connectMcpServer(config, false);
  try {
    assert.ok(runtime.hasTool('read_text_file'));
    assert.ok(runtime.hasTool('write_file'));
    const file = join(directory, 'note.txt');
    await runtime.callTool({ id: 'write', name: 'write_file', arguments: { path: file, content: 'Hello from agent0' } });
    assert.equal(await readFile(file, 'utf8'), 'Hello from agent0');
    const result = await runtime.callTool({ id: 'read', name: 'read_text_file', arguments: { path: file } });
    assert.ok(JSON.stringify(result).includes('Hello from agent0'));
    for (const path of [outside, join(directory, 'escape.txt'), join(directory, '../outside.txt')]) {
      await assert.rejects(runtime.callTool({ id: 'escape', name: 'read_text_file', arguments: { path } }), /[Aa]ccess denied|outside allowed/);
    }
    await assert.rejects(runtime.callTool({ id: 'write-outside', name: 'write_file', arguments: { path: outside, content: 'changed' } }), /[Aa]ccess denied|outside allowed/);
    assert.equal(await readFile(outside, 'utf8'), 'outside content');
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
