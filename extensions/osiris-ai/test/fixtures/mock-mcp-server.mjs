#!/usr/bin/env node
/**
 * Minimal MCP stdio server for tests. Implements initialize, tools/list and
 * tools/call for a single `echo` tool. Newline-delimited JSON-RPC 2.0.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (req.method === 'notifications/initialized') return;

  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '0.0.0' },
        },
      });
      break;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo the given text back.',
              inputSchema: {
                type: 'object',
                required: ['text'],
                properties: { text: { type: 'string' } },
              },
            },
          ],
        },
      });
      break;
    case 'tools/call':
      if (req.params?.name === 'echo') {
        const text = req.params?.arguments?.text ?? '';
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: `echo: ${text}` }] },
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Unknown tool ${req.params?.name}` },
        });
      }
      break;
    case 'resources/list':
      send({ jsonrpc: '2.0', id: req.id, result: { resources: [] } });
      break;
    default:
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
});
