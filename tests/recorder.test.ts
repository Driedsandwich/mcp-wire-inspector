import { describe, expect, it, vi } from 'vitest';
import { classify, createRecorder } from '../src/recorder.js';
import { summarize } from '../src/summary.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const request = (id: string | number = 1, method = 'tools/call'): JSONRPCMessage => ({ jsonrpc: '2.0', id, method });
const response = (id: string | number = 1): JSONRPCMessage => ({ jsonrpc: '2.0', id, result: {} });

describe('recorder', () => {
  it('classifies all JSON-RPC kinds including id zero', () => {
    expect(classify(request(0))).toBe('request');
    expect(classify(response())).toBe('response');
    expect(classify({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe('notification');
    expect(classify({ jsonrpc: '2.0', id: 0, error: { code: -32603, message: 'Failed' } })).toBe('error');
  });

  it('pairs by typed id and opposite direction, including elicitation and errors', () => {
    const recorder = createRecorder();
    recorder.record('out', request(1), 10);
    recorder.record('out', request('1'), 11);
    recorder.record('in', request(1, 'elicitation/create'), 12);
    recorder.record('in', response('1'), 20);
    recorder.record('out', response(1), 25);
    recorder.record('in', { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'No' } }, 30);
    const entries = recorder.entries();
    expect(entries.map(entry => entry.pairSeq)).toEqual([6, 4, 5, 2, 3, 1]);
    expect(entries.map(entry => entry.latencyMs)).toEqual([20, 9, 13, 9, 13, 20]);
    expect(entries[4]?.method).toBe('elicitation/create');
    expect(summarize(entries)).toMatchObject({ pending: 0, elicitations: 1, requestCount: 3, errorCount: 1 });
  });

  it('evicts in FIFO order and forgets evicted requests, with monotonic sequence after clear', () => {
    const recorder = createRecorder({ limit: 2 });
    recorder.record('out', request(1));
    recorder.record('out', request(2));
    recorder.record('out', request(3));
    expect(recorder.entries().map(entry => entry.id)).toEqual([2, 3]);
    recorder.record('in', response(1));
    expect(recorder.entries().at(-1)?.pairSeq).toBeUndefined();
    recorder.clear();
    expect(recorder.entries()).toEqual([]);
    expect(recorder.record('out', request()).seq).toBe(5);
  });

  it('defaults to 500 retained entries and rejects invalid limits', () => {
    const recorder = createRecorder();
    for (let i = 0; i < 501; i++) recorder.record('out', request(i));
    expect(recorder.entries()).toHaveLength(500);
    expect(recorder.entries()[0]?.id).toBe(1);
    for (const limit of [0, -1, 1.5, NaN, Infinity]) expect(() => createRecorder({ limit })).toThrow(RangeError);
  });

  it('redacts nested secrets and detaches live messages, hooks, snapshots and returned entries', () => {
    const source = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: {
      authorization: 'secret', nested: [{ access_token: 'secret', apiKey: 'secret', password: 'secret', text: 'original' }],
    } };
    let hookValue: JSONRPCMessage | undefined;
    const recorder = createRecorder({ redact(message) { hookValue = message; return message; } });
    const returned = recorder.record('out', source);
    source.params.nested[0]!.text = 'changed';
    expect(JSON.stringify(recorder)).not.toContain('secret');
    expect(JSON.stringify(recorder)).toContain('original');
    (hookValue as typeof source).params.nested[0]!.text = 'hook changed';
    returned.method = 'changed';
    const snapshot = recorder.entries();
    snapshot[0]!.method = 'changed';
    expect(recorder.entries()[0]?.method).toBe('tools/call');
    expect(JSON.stringify(recorder)).toContain('original');
    expect(recorder.toJSON()).toEqual(recorder.entries());
  });

  it('notifies on writes and clear, isolates failing observers and unsubscribes', () => {
    const recorder = createRecorder();
    recorder.subscribe(() => { throw new Error('Observer failure'); });
    const listener = vi.fn();
    const unsubscribe = recorder.subscribe(listener);
    recorder.record('out', request());
    recorder.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    recorder.record('out', request());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each([
    'authorization', 'token', 'accessToken', 'refresh_token', 'apiToken', 'api-key', 'password',
    'Cookie', 'Set-Cookie', 'client_secret', 'credential', 'credentials', 'passwd', 'private_key', 'private key', 'bearer',
  ])('masks secret values under the %s key', (key) => {
    const recorder = createRecorder();
    const source = { jsonrpc: '2.0' as const, id: 1, result: { nested: [{ [key]: 'fixture-sensitive-value' }] } };
    recorder.record('in', source);
    expect(recorder.entries()[0]?.message).toEqual({
      jsonrpc: '2.0', id: 1, result: { nested: [{ [key]: '[REDACTED]' }] },
    });
    expect(JSON.stringify(recorder.toJSON())).not.toContain('fixture-sensitive-value');
    expect(source.result.nested[0]?.[key]).toBe('fixture-sensitive-value');
  });

  it('masks secret header pairs while preserving ordinary pairs and labels', () => {
    const recorder = createRecorder();
    recorder.record('in', { jsonrpc: '2.0', id: 1, result: { headers: [
      { name: 'Authorization', value: 'fixture-auth', extra: 'kept' },
      { name: 'Set-Cookie', value: 'session=fixture-cookie' },
      ['authorization', 'Bearer fixture-token'],
      ['cookie', 'session=fixture-cookie'],
      { name: 'Content-Type', value: 'application/json' },
      ['Accept', 'application/json'],
      ['progressToken', 'visible'],
    ] } });
    expect(recorder.toJSON()[0]?.message).toEqual({ jsonrpc: '2.0', id: 1, result: { headers: [
      { name: 'Authorization', value: '[REDACTED]', extra: 'kept' },
      { name: 'Set-Cookie', value: '[REDACTED]' },
      ['authorization', '[REDACTED]'],
      ['cookie', '[REDACTED]'],
      { name: 'Content-Type', value: 'application/json' },
      ['Accept', 'application/json'],
      ['progressToken', 'visible'],
    ] } });
  });

  it.each([
    ['before Bearer fixture.access-token after', 'before Bearer [REDACTED] after'],
    ['before eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.signature_- after', 'before [REDACTED] after'],
    ['before\nAuthorization: Bearer fixture-token\nafter', 'before\nAuthorization: Bearer [REDACTED]\nafter'],
    ['before\nAuthorization: Basic Zml4dHVyZQ==\r\nafter', 'before\nAuthorization: [REDACTED]\r\nafter'],
    ['before\nCookie: session=fixture; other=value\nafter', 'before\nCookie: [REDACTED]\nafter'],
    ['before\nSet-Cookie: session=fixture; HttpOnly\nafter', 'before\nSet-Cookie: [REDACTED]\nafter'],
    ['before sk-proj-fixture123456 after', 'before [REDACTED] after'],
    ['before ghp_fixture123456 after', 'before [REDACTED] after'],
    ['before github_pat_fixture123456 after', 'before [REDACTED] after'],
    ['before AKIA0123456789ABCDEF after', 'before [REDACTED] after'],
    ['Ordinary text: tokens=100; sky-blue; ghp_short; AKIA123; v1.2.3.', 'Ordinary text: tokens=100; sky-blue; ghp_short; AKIA123; v1.2.3.'],
  ])('masks known string secrets and preserves surrounding text: %s', (text, masked) => {
    const recorder = createRecorder();
    recorder.record('in', { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });
    recorder.record('in', { jsonrpc: '2.0', id: 2, error: { code: -32603, message: text, data: { log: text } } });
    expect(recorder.entries()[0]?.message).toMatchObject({ result: { content: [{ text: masked }] } });
    expect(recorder.toJSON()[1]?.message).toMatchObject({ error: { message: masked, data: { log: masked } } });
  });

  it('masks overlapping string patterns fully before custom hooks and export', () => {
    const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.signature_-';
    const text = `Authorization: Bearer ${jwt}\nCookie: session=sk-proj-fixture123456; other=ghp_fixture123456\nBearer github_pat_fixture123456.`;
    const hook = vi.fn((message: JSONRPCMessage) => message);
    const recorder = createRecorder({ redact: hook });
    recorder.record('in', { jsonrpc: '2.0', id: 1, result: { text } });
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ result: {
      text: 'Authorization: Bearer [REDACTED]\nCookie: [REDACTED]\nBearer [REDACTED].',
    } });
    const exported = JSON.stringify(recorder);
    for (const secret of [jwt, 'fixture123456', 'signature_-', 'session=']) expect(exported).not.toContain(secret);
  });

  it('preserves MCP progress tokens and sampling limits while masking real token keys', () => {
    const recorder = createRecorder();
    recorder.record('out', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      _meta: { progressToken: 'progress-123' }, accessToken: 'fixture-access',
    } });
    recorder.record('in', { jsonrpc: '2.0', method: 'notifications/progress', params: {
      progressToken: 'progress-123', progress: 1, total: 2, refresh_token: 'fixture-refresh',
    } });
    recorder.record('in', { jsonrpc: '2.0', id: 2, method: 'sampling/createMessage', params: {
      maxTokens: 100, token: 'fixture-token', apiToken: 'fixture-api',
    } });
    expect(recorder.entries().map(entry => 'params' in entry.message && entry.message.params)).toEqual([
      { _meta: { progressToken: 'progress-123' }, accessToken: '[REDACTED]' },
      { progressToken: 'progress-123', progress: 1, total: 2, refresh_token: '[REDACTED]' },
      { maxTokens: 100, token: '[REDACTED]', apiToken: '[REDACTED]' },
    ]);
  });

  it('redacts exported metadata and pairs distinct original IDs even when masked to the same value', () => {
    const recorder = createRecorder({ redact(message) {
      if ('id' in message) message.id = '[MASKED]';
      if ('method' in message) message.method = '[MASKED]';
      return message;
    } });
    recorder.record('out', request('private-id-a', 'private-method'), 10);
    recorder.record('out', request('private-id-b', 'private-method'), 20);
    recorder.record('in', response('private-id-a'), 30);
    expect(summarize(recorder.entries()).pending).toBe(1);
    recorder.record('in', response('private-id-b'), 40);
    expect(recorder.entries().map(entry => entry.pairSeq)).toEqual([3, 4, 1, 2]);
    expect(summarize(recorder.entries()).pending).toBe(0);
    for (const entry of recorder.entries()) {
      expect(entry.id).toBe('[MASKED]');
      expect(entry.method).toBe('[MASKED]');
    }
    expect(JSON.stringify(recorder)).not.toContain('private-');
  });

  it('keeps a retained request pending when an evicted request has the same masked ID', () => {
    const recorder = createRecorder({ limit: 4, redact(message) {
      if ('id' in message) message.id = '[MASKED]';
      return message;
    } });
    const notification: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/message' };
    recorder.record('out', request('private-a'));
    recorder.record('in', notification);
    recorder.record('out', request('private-b'));
    recorder.record('in', notification);
    recorder.record('in', notification);
    recorder.record('in', response('private-a'));
    expect(recorder.entries().at(-1)?.pairSeq).toBeUndefined();
    expect(summarize(recorder.entries()).pending).toBe(1);
  });

  it('summarizes a recorded session, derives protocol from initialize result only', () => {
    const recorder = createRecorder();
    recorder.record('out', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'requested' } });
    expect(summarize(recorder.entries()).protocolVersion).toBeUndefined();
    recorder.record('in', { jsonrpc: '2.0', id: 1, result: {
      protocolVersion: '2025-11-25', serverInfo: { name: 'test', version: '1' }, capabilities: { tools: {} },
    } });
    recorder.record('out', request(2, 'tools/list'));
    recorder.record('in', { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'one' }, { name: 'two' }] } });
    recorder.record('out', request(3));
    recorder.record('in', { jsonrpc: '2.0', id: 3, result: { isError: true } });
    recorder.record('out', request(4));
    expect(summarize(recorder.entries())).toEqual({
      protocolVersion: '2025-11-25', serverInfo: { name: 'test', version: '1' }, capabilities: { tools: {} },
      toolCount: 2, requestCount: 4, errorCount: 1, pending: 1, elicitations: 0,
    });
  });
});
