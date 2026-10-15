# @ai-memory/client (TypeScript)

Thin, dependency-free client for ai-memory's MCP endpoint (Streamable HTTP).
It runs the `initialize` handshake once, forwards `Mcp-Session-Id` and the
bearer token, unwraps the JSON inside `result.content[].text`, and turns the
three failure shapes into typed errors:

| Failure | Error |
| --- | --- |
| Non-2xx HTTP | `McpHttpError` (`status`, `body`) |
| JSON-RPC `error` | `McpProtocolError` (`code`, `data`) |
| `result.isError: true` | `McpToolError` (`tool`) |

```js
import { AiMemoryClient } from "@ai-memory/client";

const memory = new AiMemoryClient({
  url: "http://127.0.0.1:49374/mcp",
  token: process.env.AI_MEMORY_TOKEN,
  workspace: "demo",
  project: "app",
});

await memory.writePage("notes/retries.md", "# Retry policy\nKeep the same event ID.");
const { hits } = await memory.query("retry policy");
const tools = await memory.listTools();
await memory.callTool("memory_explore", { question: "how do retries work?" });
```

It is a static client: the default `workspace`/`project` are added to every
call unless the call passes its own, `global: true`, or a `scope`. Typed
helpers cover pages, query, recent, status and handoffs; `callTool` reaches any
other tool. Retrieved memory is untrusted historical text.

Not covered: lifecycle admin operations (`/admin/restore-page`, purge), which
are root-only HTTP routes outside MCP, and the read-only `/api/v1`.

Requires Node 18+ (global `fetch`). Ships as ESM JavaScript with `index.d.ts`
types, so there is no build step. This package is not part of the root Cargo
workspace and is not published; test it with:

```bash
cd companions/ai-memory-client-ts && npm test
```
