// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder } from '../src/recorder.js';
import { mountInspector } from '../src/dom.js';

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

  it('expands pretty-printed JSON using a native button and preserves expansion on updates', () => {
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

  it('preserves keyboard focus while traffic arrives and flags tool result errors', () => {
    const { host, recorder } = fixture();
    const copy = host.querySelector<HTMLButtonElement>('button[data-action="copy"]')!;
    const seq = copy.closest('li')!.dataset.seq;
    copy.focus();
    recorder.record('in', { jsonrpc: '2.0', id: 5, result: { isError: true, content: [] } });
    expect(document.activeElement?.getAttribute('data-action')).toBe('copy');
    expect(document.activeElement?.closest('li')?.dataset.seq).toBe(seq);
    expect(host.querySelectorAll('.mcp-wire-inspector-error')).toHaveLength(2);
    const toggle = host.querySelector<HTMLButtonElement>('button[data-action="toggle"]')!;
    toggle.focus();
    recorder.record('out', { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(document.activeElement?.getAttribute('data-action')).toBe('toggle');
    expect(document.activeElement?.closest('li')?.dataset.seq).toBe(seq);
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
