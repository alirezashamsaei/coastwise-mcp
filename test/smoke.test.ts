import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';

/** Flatten a tool result's text content into a single string. */
function text(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}

/**
 * Boots the server and a client against each other over an in-memory
 * transport — no subprocess, no network, no files. Proves the MCP wiring
 * (list, call, input validation) actually works.
 */
async function connected() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('coastwise-mcp server', () => {
  it('lists the smoke tool with its description', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['smoke_check']);
    expect(tools[0]?.description).toContain('CoastWise');
  });

  it('calls the smoke tool and returns the echoed text', async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: 'smoke_check', arguments: { text: 'hi', count: 3 } });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'hi hi hi' }]);
  });

  it('rejects out-of-range input with a clear validation error', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'smoke_check',
      arguments: { text: 'hi', count: 99 },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/count/i);
  });

  it('rejects a missing required argument', async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: 'smoke_check', arguments: {} });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/text/i);
  });

  it('rejects an unknown tool name', async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: 'nope', arguments: {} });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not found/i);
  });
});
