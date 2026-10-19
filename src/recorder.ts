import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export type Direction = 'out' | 'in';
export type EntryKind = 'request' | 'response' | 'notification' | 'error';
export interface WireEntry {
  seq: number;
  direction: Direction;
  at: number;
  message: JSONRPCMessage;
  kind: EntryKind;
  method?: string;
  id?: string | number;
  pairSeq?: number;
  latencyMs?: number;
}
export interface RecorderOptions {
  limit?: number;
  /** Runs on a detached, default-redacted message. Return the message to store. */
  redact?: (message: JSONRPCMessage) => JSONRPCMessage;
}
export interface Recorder {
  record(direction: Direction, message: JSONRPCMessage, at?: number): WireEntry;
  subscribe(listener: () => void): () => void;
  entries(): WireEntry[];
  clear(): void;
  toJSON(): WireEntry[];
}

export function classify(message: JSONRPCMessage): EntryKind {
  if ('method' in message) return 'id' in message ? 'request' : 'notification';
  return 'error' in message ? 'error' : 'response';
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /authorization|token|apikey|password/i.test(key.replace(/[-_\s]/g, ''))
        ? '[REDACTED]' : redactSecrets(item),
    ]));
  }
  return value;
}

/** Records JSON-RPC messages; snapshots and custom hooks never receive live traffic. */
export function createRecorder(options: RecorderOptions = {}): Recorder {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive safe integer');
  const buffer: (WireEntry | undefined)[] = new Array(limit);
  let head = 0;
  let size = 0;
  let sequence = 0;
  const listeners = new Set<() => void>();
  // Raw IDs are private and retained only while their entries are reachable.
  const pairingIds = new WeakMap<WireEntry, string | number>();
  const retained = (): WireEntry[] => Array.from({ length: size }, (_, i) => buffer[(head + i) % limit]!);
  const notify = () => {
    for (const listener of [...listeners]) {
      // Observer failures must not interfere with the transport or other listeners.
      try { listener(); } catch { /* Ignore observer failures. */ }
    }
  };
  const entries = () => structuredClone(retained());
  return {
    record(direction, message, at = Date.now()) {
      const kind = classify(message);
      const rawId = 'id' in message ? message.id : undefined;
      let snapshot = redactSecrets(structuredClone(message)) as JSONRPCMessage;
      if (options.redact) snapshot = structuredClone(options.redact(snapshot));
      const id = 'id' in snapshot ? snapshot.id : undefined;
      const method = 'method' in snapshot ? snapshot.method : undefined;
      const entry: WireEntry = { seq: ++sequence, direction, at, message: snapshot, kind };
      if (id !== undefined) entry.id = id;
      if (method !== undefined) entry.method = method;
      if (rawId !== undefined) pairingIds.set(entry, rawId);
      if ((kind === 'response' || kind === 'error') && rawId !== undefined) {
        const request = retained().reverse().find(candidate => candidate.kind === 'request'
          && candidate.direction !== direction && pairingIds.get(candidate) === rawId && candidate.pairSeq === undefined);
        if (request) {
          entry.method = request.method;
          entry.pairSeq = request.seq;
          entry.latencyMs = Math.max(0, at - request.at);
          request.pairSeq = entry.seq;
          request.latencyMs = entry.latencyMs;
        }
      }
      if (size === limit) {
        buffer[head] = entry;
        head = (head + 1) % limit;
      } else {
        buffer[(head + size) % limit] = entry;
        size++;
      }
      const result = structuredClone(entry);
      notify();
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    entries,
    toJSON: entries,
    clear() {
      buffer.fill(undefined);
      head = 0;
      size = 0;
      notify();
    },
  };
}
