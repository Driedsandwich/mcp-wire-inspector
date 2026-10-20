import type { EntryKind, Recorder, WireEntry } from './recorder.js';
import { summarize } from './summary.js';

export interface InspectorOptions {
  /** Accessible panel heading. */
  title?: string;
}

const prefix = 'mcp-wire-inspector';
let nextMountId = 0;

function injectStyles(document: Document): void {
  if (document.querySelector(`style[data-${prefix}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(`data-${prefix}`, '');
  style.textContent = `
.${prefix} {
  --mcp-wire-inspector-background: #ffffff;
  --mcp-wire-inspector-foreground: #202428;
  --mcp-wire-inspector-muted: #545d66;
  --mcp-wire-inspector-border: #cbd0d5;
  --mcp-wire-inspector-surface: #f3f5f7;
  --mcp-wire-inspector-error: #a21b28;
  --mcp-wire-inspector-elicitation: #6842a2;
  background: var(--mcp-wire-inspector-background);
  color: var(--mcp-wire-inspector-foreground);
  border: 1px solid var(--mcp-wire-inspector-border);
  border-radius: 8px;
  padding: 16px;
  font: 14px/1.5 system-ui, sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  .${prefix} {
    --mcp-wire-inspector-background: #181c20;
    --mcp-wire-inspector-foreground: #edf0f3;
    --mcp-wire-inspector-muted: #b2bac3;
    --mcp-wire-inspector-border: #48515b;
    --mcp-wire-inspector-surface: #252b31;
    --mcp-wire-inspector-error: #ff9ca5;
    --mcp-wire-inspector-elicitation: #cfb2ff;
  }
}
.${prefix} * { box-sizing: border-box; }
.${prefix} h2 { margin: 0; font-size: 16px; }
.${prefix} header, .${prefix}-filters, .${prefix}-row-heading {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
}
.${prefix} header { justify-content: space-between; }
.${prefix}-summary, .${prefix}-status, .${prefix}-pair {
  color: var(--mcp-wire-inspector-muted);
}
.${prefix}-summary { margin: 8px 0 12px; }
.${prefix}-filters { margin-bottom: 12px; }
.${prefix}-filters label { display: flex; align-items: center; gap: 6px; }
.${prefix} button, .${prefix} input, .${prefix} select {
  font: inherit; color: inherit; background: var(--mcp-wire-inspector-surface);
  border: 1px solid var(--mcp-wire-inspector-border); border-radius: 4px;
  padding: 5px 8px;
}
.${prefix} button { cursor: pointer; }
.${prefix} :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.${prefix}-list { padding: 0; margin: 0; list-style: none; }
.${prefix}-row { padding: 10px 0; border-top: 1px solid var(--mcp-wire-inspector-border); }
.${prefix}-toggle { flex: 1; text-align: left; overflow-wrap: anywhere; }
.${prefix}-pair { display: block; font-size: 12px; }
.${prefix}-flag { font-size: 12px; font-weight: 600; }
.${prefix}-error { color: var(--mcp-wire-inspector-error); }
.${prefix}-elicitation { color: var(--mcp-wire-inspector-elicitation); }
.${prefix} pre { max-height: 360px; overflow: auto; padding: 12px;
  background: var(--mcp-wire-inspector-surface); border-radius: 4px;
  font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
}
.${prefix}-status { min-height: 1.5em; margin: 8px 0 0; }
`;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Mount an optional, framework-free view of a recorder without accessing global DOM at import time. */
export function mountInspector(
  element: HTMLElement,
  recorder: Recorder,
  options: InspectorOptions = {},
): { unmount(): void } {
  const document = element.ownerDocument;
  injectStyles(document);
  const mountId = ++nextMountId;
  const root = document.createElement('section');
  root.className = prefix;
  const headingId = `${prefix}-${mountId}-heading`;
  root.setAttribute('aria-labelledby', headingId);
  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.id = headingId;
  heading.textContent = options.title ?? 'MCP wire inspector';
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.textContent = 'Export all';
  header.append(heading, exportButton);
  const summary = document.createElement('p');
  summary.className = `${prefix}-summary`;
  const filters = document.createElement('div');
  filters.className = `${prefix}-filters`;
  const methodLabel = document.createElement('label');
  methodLabel.textContent = 'Method';
  const methodInput = document.createElement('input');
  methodInput.type = 'search';
  methodInput.placeholder = 'Filter by method';
  methodLabel.appendChild(methodInput);
  const kindLabel = document.createElement('label');
  kindLabel.textContent = 'Kind';
  const kindSelect = document.createElement('select');
  for (const kind of ['all', 'request', 'response', 'notification', 'error']) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind === 'all' ? 'All kinds' : kind;
    kindSelect.appendChild(option);
  }
  kindLabel.appendChild(kindSelect);
  filters.append(methodLabel, kindLabel);
  const list = document.createElement('ol');
  list.className = `${prefix}-list`;
  list.setAttribute('aria-label', 'Recorded messages');
  const empty = document.createElement('p');
  empty.textContent = 'No matching messages.';
  const status = document.createElement('p');
  status.className = `${prefix}-status`;
  status.setAttribute('role', 'status');
  root.append(header, summary, filters, list, empty, status);
  element.appendChild(root);

  const expanded = new Set<number>();
  const downloads = new Map<string, { timer: number; revoke(): void }>();
  let mounted = true;

  async function copyEntry(entry: WireEntry): Promise<void> {
    const clipboard = document.defaultView?.navigator.clipboard;
    try {
      if (!clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await clipboard.writeText(JSON.stringify(entry, null, 2));
      if (mounted) status.textContent = `Copied message #${entry.seq}.`;
    } catch {
      if (mounted) status.textContent = 'Could not copy JSON. Clipboard access requires browser permission and a secure context.';
    }
  }

  function render(): void {
    if (!mounted) return;
    const active = document.activeElement;
    const focusedSeq = active && list.contains(active)
      ? active.closest('li[data-seq]')?.getAttribute('data-seq') : undefined;
    const focusedAction = focusedSeq ? active?.getAttribute('data-action') : undefined;
    const entries = recorder.entries();
    const stats = summarize(entries);
    summary.textContent = [
      `Protocol: ${stats.protocolVersion ?? '—'}`,
      `Server: ${stats.serverInfo?.name ?? '—'}`,
      `Tools: ${stats.toolCount ?? '—'}`,
      `Messages: ${entries.length}`,
    ].join(' · ');
    const query = methodInput.value.toLowerCase();
    const kind = kindSelect.value as EntryKind | 'all';
    const shown = entries.filter((entry) =>
      (entry.method ?? '').toLowerCase().includes(query) && (kind === 'all' || entry.kind === kind),
    );
    list.replaceChildren();
    empty.hidden = shown.length > 0;
    const retained = new Set(entries.map((entry) => entry.seq));
    for (const seq of expanded) if (!retained.has(seq)) expanded.delete(seq);
    for (const entry of shown) {
      const row = document.createElement('li');
      row.className = `${prefix}-row`;
      row.dataset.seq = String(entry.seq);
      const rowHeading = document.createElement('div');
      rowHeading.className = `${prefix}-row-heading`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.dataset.action = 'toggle';
      toggle.className = `${prefix}-toggle`;
      const jsonId = `${prefix}-${mountId}-message-${entry.seq}`;
      toggle.setAttribute('aria-controls', jsonId);
      toggle.setAttribute('aria-expanded', String(expanded.has(entry.seq)));
      toggle.textContent = `#${entry.seq} ${entry.direction === 'out' ? 'OUT' : 'IN'} · ${entry.kind}${entry.method ? ` · ${entry.method}` : ''}${entry.id !== undefined ? ` · id ${entry.id}` : ''}`;
      const json = document.createElement('pre');
      json.id = jsonId;
      json.hidden = !expanded.has(entry.seq);
      json.textContent = JSON.stringify(entry.message, null, 2);
      toggle.addEventListener('click', () => {
        if (expanded.has(entry.seq)) expanded.delete(entry.seq);
        else expanded.add(entry.seq);
        json.hidden = !expanded.has(entry.seq);
        toggle.setAttribute('aria-expanded', String(!json.hidden));
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.dataset.action = 'copy';
      copy.textContent = 'Copy as JSON';
      copy.setAttribute('aria-label', `Copy message #${entry.seq} as JSON`);
      copy.addEventListener('click', () => { void copyEntry(entry); });
      rowHeading.append(toggle, copy);
      if (entry.kind === 'error' || ('result' in entry.message && entry.message.result.isError === true)) {
        const flag = document.createElement('span');
        flag.className = `${prefix}-flag ${prefix}-error`;
        flag.textContent = 'Error';
        rowHeading.appendChild(flag);
      }
      if (entry.method === 'elicitation/create') {
        const flag = document.createElement('span');
        flag.className = `${prefix}-flag ${prefix}-elicitation`;
        flag.textContent = 'Elicitation';
        rowHeading.appendChild(flag);
      }
      row.appendChild(rowHeading);
      if (entry.pairSeq !== undefined) {
        const pair = document.createElement('span');
        pair.className = `${prefix}-pair`;
        pair.textContent = `Paired with #${entry.pairSeq}${entry.latencyMs !== undefined ? ` · ${entry.latencyMs} ms` : ''}`;
        row.appendChild(pair);
      }
      row.appendChild(json);
      list.appendChild(row);
    }
    if (focusedSeq && focusedAction) {
      const replacement = list.querySelector<HTMLButtonElement>(
        `li[data-seq="${focusedSeq}"] button[data-action="${focusedAction}"]`,
      );
      (replacement ?? methodInput).focus({ preventScroll: true });
    }
  }

  function exportAll(): void {
    const view = document.defaultView;
    const urlApi = view?.URL;
    let url: string | undefined;
    let deferred = false;
    try {
      if (!view || !urlApi?.createObjectURL) throw new Error('Downloads are unavailable');
      const blob = new view.Blob([JSON.stringify(recorder.toJSON(), null, 2)], { type: 'application/json' });
      url = urlApi.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'mcp-wire-inspector.json';
      root.appendChild(link);
      link.click();
      link.remove();
      const downloadUrl = url;
      const revoke = () => { urlApi.revokeObjectURL(downloadUrl); };
      const timer = view.setTimeout(() => {
        revoke();
        downloads.delete(downloadUrl);
      }, 1000);
      downloads.set(downloadUrl, { timer, revoke });
      deferred = true;
      status.textContent = 'Exported recorded messages.';
    } catch {
      status.textContent = 'Could not export JSON. Downloads are unavailable in this environment.';
    } finally {
      if (url !== undefined && !deferred) urlApi?.revokeObjectURL(url);
    }
  }

  methodInput.addEventListener('input', render);
  kindSelect.addEventListener('change', render);
  exportButton.addEventListener('click', exportAll);
  let renderScheduled = false;
  const unsubscribe = recorder.subscribe(() => {
    if (renderScheduled || !mounted) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      render();
    });
  });
  render();
  return {
    unmount() {
      if (!mounted) return;
      mounted = false;
      unsubscribe();
      methodInput.removeEventListener('input', render);
      kindSelect.removeEventListener('change', render);
      exportButton.removeEventListener('click', exportAll);
      for (const download of downloads.values()) {
        document.defaultView?.clearTimeout(download.timer);
        download.revoke();
      }
      downloads.clear();
      root.remove();
      expanded.clear();
    },
  };
}
