#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerForecastTool, type ToolDeps } from './tools.js';

/**
 * CoastWise MCP.
 *
 * Never write to stdout here: the stdio transport owns it and any stray line
 * corrupts the JSON-RPC stream. Log with console.error only.
 */
export function createServer(deps: ToolDeps = {}): McpServer {
  const server = new McpServer({ name: 'coastwise-mcp', version: '0.1.0' });

  server.registerTool(
    'smoke_check',
    {
      title: 'Smoke check',
      description:
        'Health check for the CoastWise MCP server. Echoes a value back so a ' +
        'client can confirm the transport, tool listing, and input validation ' +
        'are all working.',
      inputSchema: {
        text: z.string().min(1).describe('Text to echo back.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe('How many times to repeat the text (1-5).'),
      },
    },
    ({ text, count }) => ({
      content: [{ type: 'text', text: Array.from({ length: count }, () => text).join(' ') }],
    }),
  );

  registerForecastTool(server, deps);

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('coastwise-mcp running on stdio');
}

// Only auto-start when executed directly, so tests can import createServer().
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('coastwise-mcp failed to start:', error);
    process.exit(1);
  });
}
