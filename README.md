# mcp-wire-inspector

A dependency-free recorder for Model Context Protocol (MCP) JSON-RPC traffic, with an optional framework-free DOM panel. Seeing the real messages makes browser MCP clients debuggable and demo-able: teammates and judges can inspect initialization, tool calls, and elicitation instead of relying on a screenshot of a result.

## Install

This package is **not published to npm**. Install it from GitHub:

```sh
npm install 'github:Driedsandwich/mcp-wire-inspector' @modelcontextprotocol/sdk
```

GitHub installation runs the `prepare` script to build the package. Node.js 22 or later is required. The SDK is a peer dependency (`>=1.20 <2`); tests use exactly `1.32.1`. The library has no runtime dependencies and emits ESM JavaScript and TypeScript declarations.

## Quick start

The following ten-line example assumes an existing element with ID `inspector` and a server at the example URL. The server must allow the page's Origin.

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { instrumentTransport, mountInspector } from 'mcp-wire-inspector';
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3001/mcp'));
const { recorder, restore } = instrumentTransport(transport);
const { unmount } = mountInspector(document.getElementById('inspector')!, recorder);
const client = new Client({ name: 'example', version: '1.0.0' });
await client.connect(transport);
await client.listTools();
// When finished: await client.close(); unmount(); restore();
```

For the DOM entry point alone, use `import { mountInspector } from 'mcp-wire-inspector/dom'`. All exports are also available from the package root; importing the core in Node does not access the DOM. `sideEffects: false` lets bundlers remove unused DOM code.

## API

### `instrumentTransport(transport, options?)`

Returns `{ recorder, restore }`. Instruments the supplied SDK `Transport` in place, including Streamable HTTP, SSE, stdio, and in-memory transports. Options are the same as `createRecorder`. Instrument **before** `client.connect(transport)` to capture the handshake. Outgoing messages are recorded before calling the original `send`; incoming messages before invoking the current `onmessage` callback.

The return value and errors of `send`, its options, callback arguments, and callback receiver are preserved. Assigning `onmessage` after instrumentation is supported, including SDK transports with forwarding accessors. `restore()` is idempotent: it restores the original `send` and property shape, retaining the latest receive callback so a connected client can continue. It does not close the connection or erase recorded messages. One active instrumentation per transport is supported. Hooks must be configurable; getter-only receive hooks are unsupported.

If copying or custom redaction throws during interception, that message is skipped so inspection does not break the connection. Listener exceptions are isolated. Direct `recorder.record()` calls propagate copying and redaction failures.

### `createRecorder({ limit = 500, redact? } = {})`

Creates a bounded ring buffer. `limit` must be a positive safe integer. Methods:

| Method | Result |
| --- | --- |
| `record(direction, message, at = Date.now())` | Record a JSON-RPC message manually and return a detached entry. |
| `subscribe(listener)` | Subscribe to writes and clears; returns an unsubscribe function. Listeners take no arguments. |
| `entries()` | Detached snapshot, oldest first. |
| `clear()` | Empty history and pairing state; sequence numbers continue increasing. |
| `toJSON()` | Detached entries array, also used by `JSON.stringify(recorder)`. |

Each entry contains `seq`, `direction` (`out` or `in`), `at` (milliseconds since Unix epoch), a deep-copied `message`, and `kind` (`request`, `response`, `notification`, or JSON-RPC `error`). `method` and `id` appear when available. Paired requests and responses have `pairSeq` and `latencyMs`; responses inherit their request's method for filtering. Numeric and string IDs are distinct, and requests in opposite directions can share an ID.

Default redaction recursively masks values under keys containing `authorization`, `token`, `apiKey`, or `password`, ignoring case, spaces, underscores and hyphens. The optional `redact(message)` hook receives an already default-redacted, detached copy and returns the message to store. Exported ID and method metadata follow this redacted copy; original IDs are used privately only for bounded request pairing. It can mask additional fields without mutating traffic:

```ts
const recorder = createRecorder({
  limit: 200,
  redact(message) {
    if ('params' in message && message.params) delete message.params.customerEmail;
    return message;
  },
});
```

### `summarize(entries)`

Returns `{ protocolVersion?, serverInfo?, capabilities?, toolCount?, requestCount, errorCount, pending, elicitations }`. Negotiated protocol version, server info, and capabilities come from an incoming `initialize` result. Tool count comes from the latest incoming `tools/list` result. Requests in both directions are counted; `elicitation/create` requests count as elicitations. Errors include JSON-RPC errors and tool results with `isError: true`.

The summary covers retained entries only. Tool count is the size of the latest list page, not a sum across pagination. Pairing stops when a request is evicted or history is cleared. Latency measures elapsed wall-clock time between intercepted messages, with negative clock adjustments clamped to zero. Eviction can remove handshake details from the summary.

### `mountInspector(element, recorder, { title? } = {})`

Appends a panel and returns `{ unmount }`. The panel shows the summary, method substring and kind filters, expandable pretty-printed JSON, pairing and latency, error and elicitation flags, per-entry copy, and JSON download of all retained entries. It uses native buttons, labeled controls, `aria-expanded`, and a live status region. No fonts or network assets are fetched. Clipboard access requires browser support and a secure context; copy/export failures appear in the panel.

`unmount()` unsubscribes and removes the panel; it preserves host content, recorder data, and transport state. Styles are inserted once per document and shared by mounted panels. The CSS prefix is `mcp-wire-inspector`. Override these custom properties on `.mcp-wire-inspector` (with your stylesheet after the injected style) or directly on the panel:

```css
.mcp-wire-inspector {
  --mcp-wire-inspector-background: #fff;
  --mcp-wire-inspector-foreground: #202428;
  --mcp-wire-inspector-muted: #545d66;
  --mcp-wire-inspector-border: #cbd0d5;
  --mcp-wire-inspector-surface: #f3f5f7;
  --mcp-wire-inspector-error: #a21b28;
  --mcp-wire-inspector-elicitation: #6842a2;
}
```

Defaults follow `prefers-color-scheme` for light and dark mode.

## How it works

Transport interception observes the SDK's JSON-RPC messages rather than replacing the MCP client. Receive wrappers preserve callback chains when the SDK replaces a handler, recording each incoming message once. The ring buffer stores redacted copies, matches each response to an opposite-direction request with the same typed ID, and annotates both entries with their sequence references and elapsed time. Pairing state is bounded by the same history limit.

## Browser example

`examples/browser/` contains a small Vite page. Enter any Streamable HTTP MCP server URL; the default is `http://127.0.0.1:3001/mcp`. Connect performs initialization and lists tools. The example cancels any elicitation requests rather than collecting user data.

```sh
npm install
npm run build:example
# Optional local interactive session; stop it when finished:
npx vite examples/browser --host 127.0.0.1
```

The MCP server must allow the page's Origin through CORS, including required MCP request headers and any session response headers the client needs. This package does not configure server security, bypass authentication, or provide a server. `npm run build:example` writes the example to `examples/browser/dist/`; it is excluded from the package.

## Limitations

- Records JSON-RPC messages, not raw HTTP headers, authentication metadata, SSE framing, or network-level failures. An outgoing record is a send attempt, not proof of delivery. JSON-RPC batch arrays are outside the SDK `Transport` message contract.
- Redaction is best-effort. Secrets in free text or under unrecognized keys can remain; broadly matched key names can also hide harmless values. Review exports before sharing. Custom hooks are synchronous.
- History and summaries are in memory and limited to the retained window. Reusing an outstanding ID in the same direction is ambiguous; pairing uses the latest unmatched retained request. Inspecting the same transport twice concurrently is rejected.
- The DOM panel rebuilds its bounded list on updates; it is intended for debugging and demonstrations rather than high-throughput telemetry. A restrictive Content Security Policy may block injected inline styles.
- Tests use SDK `1.32.1`. The entire peer version range and every transport implementation have not been individually tested.

## Development and testing

```sh
npm install
npm run build
npm test
npm pack --dry-run
```

`npm run build` emits `dist/*.js` and declarations; `npm run build:example` builds the browser example. Vitest unit tests cover recording, redaction, pairing, summaries and transport restoration. Integration tests use the real SDK with an ephemeral HTTP server bound to `127.0.0.1` and an in-memory pair, including a client-handled elicitation round trip. DOM tests use happy-dom. No paid API is required. The package allowlist includes only `dist`, README, LICENSE, and `package.json`.

## Origin

Extracted and generalized from the Protocol inspector of RoomLilt, built during the Build, Ship, Shape hackathon in October 2026.

## License

MIT. See [LICENSE](LICENSE).
