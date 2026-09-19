import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function startRemoteMcp() {
  const streams = new Map();
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization });
    if (request.headers.authorization !== 'Bearer test-remote-token') {
      response.writeHead(401).end('Authentication required');
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(307, { location: '/unexpected' }).end();
      return;
    }
    if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
    if (url.pathname === '/sse' && request.method === 'GET') {
      const id = randomUUID();
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`event: endpoint\ndata: /messages?session=${id}\n\n`);
      streams.set(id, response);
      response.on('close', () => streams.delete(id));
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.id === undefined) { response.writeHead(202).end(); return; }
    let result;
    if (input.method === 'initialize') {
      result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'remote-test', version: '1.0.0' } };
    } else if (input.method === 'tools/list') {
      result = { tools: [{ name: 'echo', description: 'Echo a message from a remote MCP service.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] };
    } else if (input.method === 'tools/call') {
      result = { content: [{ type: 'text', text: `Remote: ${input.params.arguments.message}` }] };
    } else result = {};
    const message = JSON.stringify({ jsonrpc: '2.0', id: input.id, result });
    if (url.pathname === '/messages') {
      const stream = streams.get(url.searchParams.get('session'));
      if (!stream) { response.writeHead(404).end(); return; }
      stream.write(`event: message\ndata: ${message}\n\n`);
      response.writeHead(202).end();
    } else {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' }).end(message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      for (const stream of streams.values()) stream.end();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
