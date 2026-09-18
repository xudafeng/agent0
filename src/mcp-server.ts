import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'agent0-demo-server', version: '1.0.0' });

server.registerTool(
  'greet',
  {
    description: 'Greet someone by name.',
    inputSchema: z.object({
      name: z.string().describe('The name to greet.'),
    }),
  },
  async ({ name }) => ({
    content: [{ type: 'text', text: `Hello, ${name}!` }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
