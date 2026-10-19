import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentTransport, mountInspector } from '../../src/index.js';

const form = document.querySelector<HTMLFormElement>('#connection')!;
const url = document.querySelector<HTMLInputElement>('#url')!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const disconnect = document.querySelector<HTMLButtonElement>('#disconnect')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const host = document.querySelector<HTMLDivElement>('#inspector')!;
let session: { client: Client; restore(): void } | undefined;
let panel: { unmount(): void } | undefined;

async function close(): Promise<void> {
  const previous = session;
  session = undefined;
  if (previous) {
    try { await previous.client.close(); }
    finally { previous.restore(); }
  }
  disconnect.disabled = true;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  connect.disabled = true;
  disconnect.disabled = true;
  try {
    const endpoint = new URL(url.value);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Use an HTTP or HTTPS server URL.');
    await close();
    panel?.unmount();
    host.replaceChildren();
    const client = new Client({ name: 'wire-inspector-example', version: '0.1.0' }, {
      capabilities: { elicitation: { form: {} } },
    });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' as const }));
    const transport = new StreamableHTTPClientTransport(endpoint);
    const { recorder, restore } = instrumentTransport(transport);
    panel = mountInspector(host, recorder);
    session = { client, restore };
    status.textContent = 'Connecting…';
    await client.connect(transport);
    const tools = await client.listTools();
    status.textContent = `Connected. ${tools.tools.length} tools returned.`;
    disconnect.disabled = false;
  } catch (error) {
    status.textContent = `Connection failed: ${error instanceof Error ? error.message : String(error)}`;
    await close().catch(() => {});
  } finally {
    connect.disabled = false;
  }
});

disconnect.addEventListener('click', async () => {
  connect.disabled = true;
  try {
    await close();
    status.textContent = 'Disconnected. Recorded messages remain visible.';
  } catch (error) {
    status.textContent = `Disconnect failed: ${String(error)}`;
  } finally {
    connect.disabled = false;
  }
});
