// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder } from '../src/recorder.js';
import { mountInspector } from '../src/dom.js';
import { instrumentTransport } from '../src/instrument.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture() {
  const recorder = createRecorder();
  recorder.record('out', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 0);
  recorder.record('in', {
    jsonrpc: '2.0', id: 1,
    result: { protocolVersion: '2025-11-25', serverInfo: { name: 'Fixture server', version: '1' }, capabilities: {} },
  }, 12);
  recorder.record('out', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 20);
  recorder.record('in', { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo' }] } }, 24);
  recorder.record('in', { jsonrpc: '2.0', id: 'ask', method: 'elicitation/create', params: {} }, 30);
  recorder.record('in', { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'Fixture error' } }, 40);
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { recorder, host, panel: mountInspector(host, recorder) };
}

describe('mountInspector', () => {
  it('renders the summary, messages, pairing, and error and elicitation flags', () => {
    const { host } = fixture();
    expect(host.textContent).toContain('Protocol: 2025-11-25');
    expect(host.textContent).toContain('Server: Fixture server');
    expect(host.textContent).toContain('Tools: 1');
    expect(host.textContent).toContain('Messages: 6');
    expect(host.querySelectorAll('li')).toHaveLength(6);
    expect(host.textContent).toContain('12 ms');
    expect(host.querySelector('.mcp-wire-inspector-error')?.textContent).toBe('Error');
    expect(host.querySelector('.mcp-wire-inspector-elicitation')?.textContent).toBe('Elicitation');
  });

  it('filters by case-insensitive method substring and kind', () => {
    const { host } = fixture();
    const input = host.querySelector('input')!;
    input.value = 'TOOLS/';
    input.dispatchEvent(new Event('input'));
    const filtered = [...host.querySelectorAll('li')];
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((row) => row.textContent?.includes('tools/list'))).toBe(true);
    const select = host.querySelector('select')!;
    select.value = 'request';
    select.dispatchEvent(new Event('change'));
    expect(host.querySelectorAll('li')).toHaveLength(1);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    select.value = 'error';
    select.dispatchEvent(new Event('change'));
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.querySelector('li')?.textContent).toContain('error');
  });

  it('expands pretty-printed JSON using a native button and preserves expansion on updates', async () => {
    const { host, recorder } = fixture();
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const json = host.querySelector('pre')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(json.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(json.hidden).toBe(false);
    expect(json.textContent).toContain('\n  "jsonrpc": "2.0"');
    expect(toggle.getAttribute('aria-controls')).toBe(json.id);
    recorder.record('out', { jsonrpc: '2.0', method: 'notifications/initialized' });
    await Promise.resolve();
    expect(host.querySelector('pre')?.hidden).toBe(false);
    host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
    expect(host.querySelector('pre')?.hidden).toBe(true);
  });

  it('copies an entry as JSON and exports all recorded entries', async () => {
    vi.useFakeTimers();
    const { host, recorder } = fixture();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard);
    host.querySelector<HTMLButtonElement>('button[aria-label^="Copy message"]')!.click();
    await Promise.resolve();
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(recorder.entries()[0]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Copied message');
    const createObjectURL = vi.fn(() => 'blob:fixture');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    host.querySelector<HTMLButtonElement>('header button')!.click();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
    expect(host.querySelector('a')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('preserves keyboard focus while traffic arrives and flags tool result errors', async () => {
    const { host, recorder } = fixture();
    const copy = host.querySelector<HTMLButtonElement>('button[data-action="copy"]')!;
    const seq = copy.closest('li')!.dataset.seq;
    copy.focus();
    recorder.record('in', { jsonrpc: '2.0', id: 5, result: { isError: true, content: [] } });
    await Promise.resolve();
    expect(document.activeElement?.getAttribute('data-action')).toBe('copy');
    expect(document.activeElement?.closest('li')?.dataset.seq).toBe(seq);
    expect(host.querySelectorAll('.mcp-wire-inspector-error')).toHaveLength(2);
    const toggle = host.querySelector<HTMLButtonElement>('button[data-action="toggle"]')!;
    toggle.focus();
    recorder.record('out', { jsonrpc: '2.0', method: 'notifications/initialized' });
    await Promise.resolve();
    expect(document.activeElement?.getAttribute('data-action')).toBe('toggle');
    expect(document.activeElement?.closest('li')?.dataset.seq).toBe(seq);
  });

  it('coalesces traffic bursts into one asynchronous render and keeps subscriptions synchronous', async () => {
    const { recorder, host, panel } = fixture();
    const entries = vi.spyOn(recorder, 'entries');
    const listener = vi.fn();
    const unsubscribe = recorder.subscribe(listener);
    recorder.record('out', { jsonrpc: '2.0', id: 10, method: 'tools/list' });
    recorder.record('in', { jsonrpc: '2.0', id: 10, result: { tools: [] } });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(entries).not.toHaveBeenCalled();
    expect(host.querySelectorAll('li')).toHaveLength(6);
    await Promise.resolve();
    expect(entries).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('li')).toHaveLength(8);
    recorder.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(host.textContent).toContain('Messages: 0');
    unsubscribe();
    panel.unmount();
  });

  it('sends before panel rendering so render time does not inflate synchronous round-trip latency', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const transport: Transport = {
      async start() {}, async close() {},
      send: vi.fn(async function (this: Transport, message) {
        expect(now).toBe(1000);
        if ('id' in message) this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: {} });
      }),
    };
    const { recorder, restore } = instrumentTransport(transport);
    transport.onmessage = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = mountInspector(host, recorder);
    const originalEntries = recorder.entries;
    const entries = vi.spyOn(recorder, 'entries').mockImplementation(() => {
      now += 100;
      return originalEntries();
    });
    const sent = transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(entries).not.toHaveBeenCalled();
    expect(recorder.toJSON().map(entry => entry.latencyMs)).toEqual([0, 0]);
    await sent;
    expect(entries).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('li')).toHaveLength(2);
    panel.unmount();
    restore();
  });

  it('does not render a queued update after unmount', async () => {
    const { recorder, host, panel } = fixture();
    const entries = vi.spyOn(recorder, 'entries');
    recorder.record('out', { jsonrpc: '2.0', method: 'notifications/initialized' });
    panel.unmount();
    await Promise.resolve();
    expect(entries).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0);
  });

  it('displays, copies and downloads redacted free text without changing traffic', async () => {
    const { recorder, host, panel } = fixture();
    const source = { jsonrpc: '2.0' as const, id: 99, result: {
      content: [{ type: 'text', text: 'before Bearer fixture-sensitive-value after' }],
    } };
    recorder.record('in', source);
    await Promise.resolve();
    const row = host.querySelector('li[data-seq="7"]')!;
    expect(row.querySelector('pre')?.textContent).toContain('before Bearer [REDACTED] after');
    expect(host.textContent).not.toContain('fixture-sensitive-value');
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard);
    row.querySelector<HTMLButtonElement>('button[data-action="copy"]')!.click();
    await Promise.resolve();
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(recorder.toJSON()[6]);
    expect(writeText.mock.calls[0]![0]).not.toContain('fixture-sensitive-value');
    const createObjectURL = vi.fn((_: Blob) => 'blob:redacted');
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    host.querySelector<HTMLButtonElement>('header button')!.click();
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    const download = await blob.text();
    expect(JSON.parse(download)).toEqual(recorder.toJSON());
    expect(download).not.toContain('fixture-sensitive-value');
    expect(source.result.content[0]?.text).toBe('before Bearer fixture-sensitive-value after');
    panel.unmount();
  });

  it('revokes outstanding download URLs on unmount', () => {
    vi.useFakeTimers();
    const { host, panel } = fixture();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = () => 'blob:unmount';
      static revokeObjectURL = revokeObjectURL;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    host.querySelector<HTMLButtonElement>('header button')!.click();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    panel.unmount();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:unmount');
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('injects styles once and unmounts only its own panel with its subscription removed', () => {
    const { recorder, host, panel } = fixture();
    const unsubscribe = vi.fn();
    const subscription = vi.spyOn(recorder, 'subscribe').mockReturnValue(unsubscribe);
    const second = mountInspector(host, recorder);
    expect(subscription).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('style[data-mcp-wire-inspector]')).toHaveLength(1);
    second.unmount();
    second.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('section')).toHaveLength(1);
    panel.unmount();
    expect(host.children).toHaveLength(0);
    recorder.record('out', { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(host.children).toHaveLength(0);
  });
});
