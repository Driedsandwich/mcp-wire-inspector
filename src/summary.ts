import type { ServerCapabilities, Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { WireEntry } from './recorder.js';

export interface TrafficSummary {
  protocolVersion?: string;
  serverInfo?: Implementation;
  capabilities?: ServerCapabilities;
  toolCount?: number;
  requestCount: number;
  errorCount: number;
  pending: number;
  elicitations: number;
}

/** Summarizes the retained window, not traffic already evicted from the recorder. */
export function summarize(entries: readonly WireEntry[]): TrafficSummary {
  const summary: TrafficSummary = { requestCount: 0, errorCount: 0, pending: 0, elicitations: 0 };
  const pending = new Map<number, WireEntry>();
  for (const entry of entries) {
    if (entry.kind === 'request') {
      summary.requestCount++;
      if (entry.method === 'elicitation/create') summary.elicitations++;
      pending.set(entry.seq, entry);
    }
    if (entry.kind === 'error') summary.errorCount++;
    if (entry.kind !== 'response' && entry.kind !== 'error') continue;
    // Exported IDs may be masked to the same value; only recorder pairing is authoritative.
    const request = entry.pairSeq !== undefined ? pending.get(entry.pairSeq) : undefined;
    if (request) pending.delete(request.seq);
    const method = request?.method ?? entry.method;
    if (entry.kind === 'error' || !('result' in entry.message)) continue;
    const result = entry.message.result;
    if (method === 'initialize' && entry.direction === 'in') {
      if (typeof result.protocolVersion === 'string') summary.protocolVersion = result.protocolVersion;
      if (result.serverInfo && typeof result.serverInfo === 'object') summary.serverInfo = structuredClone(result.serverInfo) as Implementation;
      if (result.capabilities && typeof result.capabilities === 'object') summary.capabilities = structuredClone(result.capabilities) as ServerCapabilities;
    }
    if (method === 'tools/list' && entry.direction === 'in' && Array.isArray(result.tools)) summary.toolCount = result.tools.length;
    if (result.isError === true) summary.errorCount++;
  }
  summary.pending = pending.size;
  return summary;
}
