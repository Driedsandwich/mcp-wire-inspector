import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { instrumentTransport } from '../src/instrument.js';
import type { WireEntry } from '../src/recorder.js';
import { summarize } from '../src/summary.js';

function createTestServer() {
  const server = new McpServer({ name: 'wire-inspector-test', version: '1.0.0' });
  server.registerTool('greet', {
    description: 'Returns a greeting.',
    inputSchema: { name: z.string() },
  }, async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }));
  server.registerTool('confirm', {
    description: 'Requests confirmation from the client.',
    inputSchema: {},
  }, async (_arguments, extra) => {
    const result = await server.server.elicitInput({
      mode: 'form',
      message: 'Please confirm the test action.',
      requestedSchema: {
        type: 'object',
        properties: { confirmed: { type: 'boolean' } },
        required: ['confirmed'],
      },
    }, { relatedRequestId: extra.requestId, timeout: 5000 });
    return { content: [{ type: 'text', text: `${result.action}:${result.content?.confirmed}` }] };
  });
  return server;
}

function expectPaired(request: WireEntry, entries: WireEntry[]) {
  const response = entries.find(entry => entry.seq === request.pairSeq);
  expect(response).toBeDefined();
  expect(response?.kind).toBe('response');
  expect(response?.id).toBe(request.id);
  expect(response?.method).toBe(request.method);
  expect(response?.direction).toBe(request.direction === 'out' ? 'in' : 'out');
  expect(response?.pairSeq).toBe(request.seq);
  expect(response!.seq).toBeGreaterThan(request.seq);
  expect(response!.latencyMs).toBeGreaterThanOrEqual(0);
  expect(request.latencyMs).toBe(response!.latencyMs);
  return response!;
}

describe('official SDK integration', () => {
  it('queues a message received before the instrumented server connects and records it once', async () => {
    const server = createTestServer();
    const client = new Client({ name: 'early-message-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { recorder, restore } = instrumentTransport(serverTransport);
    const earlyMessage = {
      jsonrpc: '2.0' as const,
      method: 'notifications/early-message',
      params: { text: 'Queued before connect' },
    };
    const received = vi.fn();
    server.server.setNotificationHandler(z.object({
      jsonrpc: z.literal('2.0'),
      method: z.literal('notifications/early-message'),
      params: z.object({ text: z.string() }),
    }), received);

    try {
      await clientTransport.send(earlyMessage);
      expect(received).not.toHaveBeenCalled();
      expect(recorder.entries()).toEqual([]);
      await server.connect(serverTransport);
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      expect(received.mock.calls[0]?.[0]).toEqual(earlyMessage);
      await client.connect(clientTransport, { timeout: 5000 });
      const earlyEntries = recorder.entries().filter(entry => entry.method === earlyMessage.method);
      expect(earlyEntries).toHaveLength(1);
      expect(earlyEntries[0]).toMatchObject({ direction: 'in', message: earlyMessage });
      expect(received).toHaveBeenCalledOnce();
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      restore();
    }
  });

  it('records a real Streamable HTTP session and bidirectional elicitation', async () => {
    const server = createTestServer();
    const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const sockets = new Set<Socket>();
    const requestErrors: unknown[] = [];
    const http = createServer((request, response) => {
      if (request.url !== '/mcp') {
        response.writeHead(404).end();
        return;
      }
      void serverTransport.handleRequest(request, response).catch(error => {
        requestErrors.push(error);
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      });
    });
    http.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const client = new Client({ name: 'wire-inspector-client', version: '1.0.0' }, {
      capabilities: { elicitation: { form: {} } },
    });
    let restore: (() => void) | undefined;
    let elicitationsHandled = 0;
    client.setRequestHandler(ElicitRequestSchema, async request => {
      expect(request.params.mode).toBe('form');
      expect(request.params.message).toBe('Please confirm the test action.');
      elicitationsHandled++;
      return { action: 'accept', content: { confirmed: true } };
    });

    try {
      await server.connect(serverTransport);
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', () => {
          http.off('error', reject);
          resolve();
        });
      });
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port');
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
      const instrumentation = instrumentTransport(transport);
      restore = instrumentation.restore;
      // Client.connect assigns onmessage after instrumentation and sends initialize.
      await client.connect(transport, { timeout: 5000 });
      const tools = await client.listTools({}, { timeout: 5000 });
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(['confirm', 'greet']);
      expect(await client.callTool({ name: 'greet', arguments: { name: 'Inspector' } }, undefined, { timeout: 5000 })).toMatchObject({
        content: [{ type: 'text', text: 'Hello, Inspector!' }],
      });
      expect(await client.callTool({ name: 'confirm', arguments: {} }, undefined, { timeout: 5000 })).toMatchObject({
        content: [{ type: 'text', text: 'accept:true' }],
      });
      expect(elicitationsHandled).toBe(1);

      const entries = instrumentation.recorder.entries();
      expect(entries.map(entry => entry.seq)).toEqual(entries.map((_, index) => index + 1));
      const outgoingRequests = entries.filter(entry => entry.direction === 'out' && entry.kind === 'request');
      expect(outgoingRequests.map(entry => entry.method)).toEqual(['initialize', 'tools/list', 'tools/call', 'tools/call']);
      for (const request of outgoingRequests) expectPaired(request, entries);
      const initialized = entries.find(entry => entry.method === 'notifications/initialized');
      expect(initialized).toMatchObject({ direction: 'out', kind: 'notification' });
      expect(initialized!.seq).toBeGreaterThan(outgoingRequests[0]!.pairSeq!);
      expect(initialized!.seq).toBeLessThan(outgoingRequests[1]!.seq);
      const elicitation = entries.find(entry => entry.method === 'elicitation/create' && entry.kind === 'request');
      expect(elicitation).toMatchObject({ direction: 'in' });
      const elicitationResponse = expectPaired(elicitation!, entries);
      expect(elicitationResponse.message).toMatchObject({ result: { action: 'accept', content: { confirmed: true } } });
      expect(elicitation!.seq).toBeGreaterThan(outgoingRequests[3]!.seq);
      expect(elicitationResponse.seq).toBeLessThan(outgoingRequests[3]!.pairSeq!);
      expect(summarize(entries)).toMatchObject({
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'wire-inspector-test', version: '1.0.0' },
        toolCount: 2,
        requestCount: 5,
        errorCount: 0,
        pending: 0,
        elicitations: 1,
      });
      expect(requestErrors).toEqual([]);
    } finally {
      // Closing protocols aborts SSE reads; destroy any remaining keep-alive sockets.
      await Promise.allSettled([client.close(), server.close()]);
      restore?.();
      await new Promise<void>((resolve, reject) => {
        http.close(error => {
          if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error);
          else resolve();
        });
        http.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
    }
  });

  it('records initialize and a tool call over a real linked in-memory pair', async () => {
    const server = createTestServer();
    const client = new Client({ name: 'in-memory-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { recorder, restore } = instrumentTransport(clientTransport);
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport, { timeout: 5000 });
      expect(await client.callTool({ name: 'greet', arguments: { name: 'Memory' } }, undefined, { timeout: 5000 })).toMatchObject({
        content: [{ type: 'text', text: 'Hello, Memory!' }],
      });
      const entries = recorder.entries();
      const requests = entries.filter(entry => entry.kind === 'request');
      expect(requests.map(entry => [entry.direction, entry.method])).toEqual([
        ['out', 'initialize'], ['out', 'tools/call'],
      ]);
      for (const request of requests) expectPaired(request, entries);
      expect(summarize(entries)).toMatchObject({
        protocolVersion: '2025-11-25', requestCount: 2, errorCount: 0, pending: 0,
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      restore();
    }
  });
});
