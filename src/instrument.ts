import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createRecorder } from './recorder.js';
import type { Direction, Recorder, RecorderOptions } from './recorder.js';

const active = new WeakSet<Transport>();

/** Intercepts an SDK transport in place; restore preserves the latest receive handler. */
export function instrumentTransport(transport: Transport, options?: RecorderOptions): {
  recorder: Recorder;
  restore: () => void;
} {
  if (active.has(transport)) throw new Error('Transport is already instrumented');
  const recorder = createRecorder(options);
  let restored = false;
  const sendDescriptor = Object.getOwnPropertyDescriptor(transport, 'send');
  const receiveDescriptor = Object.getOwnPropertyDescriptor(transport, 'onmessage');
  let inheritedReceive: PropertyDescriptor | undefined;
  for (let prototype = Object.getPrototypeOf(transport); prototype; prototype = Object.getPrototypeOf(prototype)) {
    inheritedReceive = Object.getOwnPropertyDescriptor(prototype, 'onmessage');
    if (inheritedReceive) break;
  }
  const receiveAccessor = receiveDescriptor ?? inheritedReceive;
  if (receiveAccessor?.get && !receiveAccessor.set) throw new TypeError('Transport receive hook must be writable');
  for (const descriptor of [sendDescriptor, receiveDescriptor]) {
    if (descriptor && !descriptor.configurable) throw new TypeError('Transport hooks must be configurable');
  }
  const originalSend = transport.send;
  let handler = transport.onmessage;
  const record = (direction: Direction, message: Parameters<Transport['send']>[0]) => {
    // Inspection is best-effort: a failing copy/redaction hook cannot break MCP traffic.
    if (!restored) {
      try { recorder.record(direction, message); } catch { /* Leave transport behavior intact. */ }
    }
  };
  const wrappedSend: Transport['send'] = function (this: Transport, ...args) {
    record('out', args[0]);
    return originalSend.apply(this, args);
  };
  const receiving = new WeakSet<object>();
  const wrapReceive = (callback: Transport['onmessage']): Transport['onmessage'] => callback === undefined ? undefined : function (this: Transport, ...args) {
    // Protocol.connect chains its handler to the previously installed callback.
    // Each assignment captures that callback, and a chain records a message once.
    const nested = receiving.has(args[0]);
    if (!nested) receiving.add(args[0]);
    try {
      if (!nested) record('in', args[0]);
      callback.apply(this, args);
    } finally {
      if (!nested) receiving.delete(args[0]);
    }
  };
  let wrappedReceive = wrapReceive(handler);
  const getter = () => wrappedReceive;
  // Some SDK transports forward this property into an underlying transport.
  // Preserve an unset hook there too so the transport can queue early messages.
  const forwardReceive = () => receiveAccessor?.set?.call(transport, wrappedReceive);
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: receiveDescriptor?.enumerable ?? true,
    get: getter,
    set: (value: Transport['onmessage']) => {
      handler = value;
      wrappedReceive = wrapReceive(value);
      forwardReceive();
    },
  });
  try {
    forwardReceive();
    Object.defineProperty(transport, 'send', {
      configurable: true, writable: true, enumerable: sendDescriptor?.enumerable ?? true, value: wrappedSend,
    });
  } catch (error) {
    if (receiveDescriptor) Object.defineProperty(transport, 'onmessage', receiveDescriptor);
    else Reflect.deleteProperty(transport, 'onmessage');
    receiveAccessor?.set?.call(transport, handler);
    throw error;
  }
  active.add(transport);
  return {
    recorder,
    restore() {
      if (restored) return;
      restored = true;
      if (transport.send === wrappedSend) {
        if (sendDescriptor) Object.defineProperty(transport, 'send', sendDescriptor);
        else Reflect.deleteProperty(transport, 'send');
      }
      if (Object.getOwnPropertyDescriptor(transport, 'onmessage')?.get === getter) {
        if (receiveDescriptor && !('value' in receiveDescriptor)) {
          Object.defineProperty(transport, 'onmessage', receiveDescriptor);
          receiveDescriptor.set?.call(transport, handler);
        } else if (receiveDescriptor) {
          Object.defineProperty(transport, 'onmessage', { ...receiveDescriptor, value: handler });
        } else {
          Reflect.deleteProperty(transport, 'onmessage');
          if (handler !== undefined || receiveAccessor?.set) transport.onmessage = handler;
        }
      }
      active.delete(transport);
    },
  };
}
