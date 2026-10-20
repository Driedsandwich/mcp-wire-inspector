import { describe, expect, it, vi } from 'vitest';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { instrumentTransport } from '../src/instrument.js';

const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const makeTransport = (): Transport => ({ start: async () => {}, close: async () => {}, send: vi.fn(async () => {}) });

describe('transport instrumentation', () => {
  it('exposes an unset receive handler and preserves it when cleared and restored', () => {
    const transport = makeTransport();
    const { recorder, restore } = instrumentTransport(transport);
    expect(transport.onmessage).toBeUndefined();
    transport.onmessage = vi.fn();
    expect(transport.onmessage).toBeTypeOf('function');
    transport.onmessage = undefined;
    expect(transport.onmessage).toBeUndefined();
    expect(recorder.entries()).toEqual([]);
    restore();
    expect(transport.onmessage).toBeUndefined();
    expect(Object.hasOwn(transport, 'onmessage')).toBe(false);
  });

  it('captures a receive handler assigned after wrapping, preserving arguments and this', async () => {
    const transport = makeTransport();
    const send = transport.send;
    const { recorder, restore } = instrumentTransport(transport);
    const handler = vi.fn();
    transport.onmessage = handler;
    const extra = { requestInfo: { headers: { example: 'value' } } };
    transport.onmessage!(message, extra);
    const options = { relatedRequestId: 2 };
    const promise = transport.send(message, options);
    expect(send).toHaveBeenCalledWith(message, options);
    expect(vi.mocked(send).mock.contexts[0]).toBe(transport);
    expect(promise).toBe(vi.mocked(send).mock.results[0]?.value);
    await promise;
    expect(handler).toHaveBeenCalledWith(message, extra);
    expect(handler.mock.contexts[0]).toBe(transport);
    expect(recorder.entries().map(entry => entry.direction)).toEqual(['in', 'out']);
    restore();
    expect(transport.send).toBe(send);
    expect(transport.onmessage).toBe(handler);
    restore();
    transport.onmessage!(message);
    expect(recorder.entries()).toHaveLength(2);
  });

  it('restores the original callback and inherited send method without creating own fields', () => {
    const callback = vi.fn();
    class Example {
      onmessage = callback;
      async start() {}
      async close() {}
      async send() {}
    }
    const transport = new Example();
    const original = transport.send;
    const { restore } = instrumentTransport(transport);
    restore();
    expect(transport.send).toBe(original);
    expect(Object.hasOwn(transport, 'send')).toBe(false);
    expect(transport.onmessage).toBe(callback);
  });

  it('supports SDK-style callback chaining without recursion or duplicate recording', () => {
    const transport = makeTransport();
    const initial = vi.fn();
    transport.onmessage = initial;
    const { recorder, restore } = instrumentTransport(transport);
    const previous = transport.onmessage;
    const current = vi.fn((incoming: JSONRPCMessage) => { previous?.(incoming); });
    transport.onmessage = current;
    transport.onmessage!(message);
    expect(initial).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledOnce();
    expect(recorder.entries()).toHaveLength(1);
    restore();
    transport.onmessage!(message);
    expect(initial).toHaveBeenCalledTimes(2);
    expect(current).toHaveBeenCalledTimes(2);
    expect(recorder.entries()).toHaveLength(1);
  });

  it('forwards into accessor-based transports and restores their latest handler', () => {
    let underlying: Transport['onmessage'];
    class ForwardingTransport {
      get onmessage() { return underlying; }
      set onmessage(value: Transport['onmessage']) { underlying = value; }
      async start() {}
      async close() {}
      async send() {}
    }
    const transport = new ForwardingTransport();
    const { recorder, restore } = instrumentTransport(transport);
    expect(transport.onmessage).toBeUndefined();
    expect(underlying).toBeUndefined();
    const handler = vi.fn();
    transport.onmessage = handler;
    underlying!(message);
    expect(recorder.entries()).toHaveLength(1);
    expect(handler).toHaveBeenCalledWith(message);
    transport.onmessage = undefined;
    expect(transport.onmessage).toBeUndefined();
    expect(underlying).toBeUndefined();
    transport.onmessage = handler;
    restore();
    expect(Object.hasOwn(transport, 'onmessage')).toBe(false);
    expect(underlying).toBe(handler);
  });

  it('preserves send failures and callback failures even if redaction fails', async () => {
    const transport = makeTransport();
    const error = new Error('Send failed');
    transport.send = vi.fn(() => Promise.reject(error));
    const { recorder } = instrumentTransport(transport, { redact() { throw new Error('Hook failed'); } });
    await expect(transport.send(message)).rejects.toBe(error);
    transport.onmessage = () => { throw error; };
    expect(() => transport.onmessage!(message)).toThrow(error);
    expect(recorder.entries()).toEqual([]);
  });

  it('rejects double instrumentation and non-configurable hooks without partial changes', () => {
    const transport = makeTransport();
    const { restore } = instrumentTransport(transport);
    expect(() => instrumentTransport(transport)).toThrow('already instrumented');
    restore();
    const send = transport.send;
    Object.defineProperty(transport, 'onmessage', { configurable: false, value: undefined });
    expect(() => instrumentTransport(transport)).toThrow(TypeError);
    expect(transport.send).toBe(send);
  });
});
