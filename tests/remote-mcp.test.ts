import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { startRemoteMcp } from './fixtures/remote-mcp.mjs';
import { checkMcpServers, connectMcpServer } from '../src/mcp.js';
import { encodeMcpServers, loadMcpServers, validateMcpServers, type McpServerConfig } from '../src/mcp-config.js';

const config = { id: 'remote', transport: 'http' as const, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer test-remote-token' }, enabled: true };

test('remote configuration validates protocols and headers and preserves local settings', () => {
  assert.deepEqual(loadMcpServers(encodeMcpServers([config])), [config]);
  for (const patch of [
    { url: 'file:///tmp/server' }, { url: 'https://user:password@example.com/mcp' },
    { url: 'not a URL' }, { transport: 'unknown' }, { headers: [] },
    { headers: { Authorization: 'bad\r\nInjected: yes' } },
    { headers: { Host: 'other-host' } }, { headers: { Authorization: 'one', authorization: 'two' } },
  ]) assert.throws(() => validateMcpServers([{ ...config, ...patch }]), /Invalid MCP configuration/);
});

for (const transport of ['http', 'sse'] as const) {
  test(`remote ${transport} supports authenticated connections and tools`, async () => {
    const fixture = await startRemoteMcp();
    let runtime;
    try {
      const server: McpServerConfig = { ...config, transport, url: `${fixture.url}/${transport === 'http' ? 'mcp' : 'sse'}` };
      runtime = await connectMcpServer(server);
      assert.equal(runtime.tools.length, 1);
      const result = await runtime.callTool({ id: 'remote-call', name: runtime.tools[0]!.name, arguments: { message: 'it works' } });
      assert.deepEqual(result, [{ type: 'text', text: 'Remote: it works' }]);
      const checked = await checkMcpServers([server]);
      assert.equal(checked[0]?.status, 'reachable');
      assert.equal(checked[0]?.toolCount, 1);
      await runtime.close();
      runtime = undefined;
      assert.ok(fixture.requests.every((request) => request.authorization === 'Bearer test-remote-token'));
      if (transport === 'http') assert.ok(fixture.requests.some((request) => request.method === 'DELETE'));
      else assert.ok(fixture.requests.some((request) => request.method === 'GET' && request.path === '/sse'));
    } finally { await runtime?.close(); await fixture.close(); }
  });
}

test('remote authentication failures and redirects are reported as failed connectivity', async () => {
  const fixture = await startRemoteMcp();
  try {
    for (const transport of ['http', 'sse'] as const) {
      const server = { ...config, transport, url: `${fixture.url}/${transport === 'http' ? 'mcp' : 'sse'}`, headers: {} };
      const checked = await checkMcpServers([server]);
      assert.equal(checked[0]?.status, 'failed');
    }
    await assert.rejects(connectMcpServer({ ...config, url: `${fixture.url}/redirect` }));
    assert.ok(!fixture.requests.some((request) => request.path === '/unexpected'));
  } finally { await fixture.close(); }
});

test('successful SSE connections remain usable after the initialization deadline', async () => {
  const fixture = await startRemoteMcp();
  let runtime;
  try {
    runtime = await connectMcpServer({ ...config, transport: 'sse', url: `${fixture.url}/sse` });
    await setTimeout(15200);
    const result = await runtime.callTool({ id: 'after-idle', name: runtime.tools[0]!.name, arguments: { message: 'still connected' } });
    assert.deepEqual(result, [{ type: 'text', text: 'Remote: still connected' }]);
    assert.equal(fixture.requests.filter((request) => request.method === 'GET' && request.path === '/sse').length, 1);
  } finally { await runtime?.close(); await fixture.close(); }
});
