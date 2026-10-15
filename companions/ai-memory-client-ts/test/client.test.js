import { test } from "node:test";
import assert from "node:assert/strict";
import { AiMemoryClient, McpProtocolError, McpToolError, McpHttpError } from "../src/index.js";

function fakeServer(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const message = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, message });
    const { status = 200, body = "", headers = {} } = handler(message, calls) ?? {};
    return new Response(body, { status, headers });
  };
  return { fetch, calls };
}

const json = (id, result) => ({
  body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  headers: { "content-type": "application/json" },
});

function toolServer(onCall) {
  return fakeServer((m) => {
    if (m.method === "initialize") {
      return { ...json(m.id, { protocolVersion: "2024-11-05" }), headers: { "content-type": "application/json", "mcp-session-id": "s-1" } };
    }
    if (m.method === "notifications/initialized") return { status: 202 };
    return onCall(m);
  });
}

test("handshakes once, forwards session and token, fills default scope", async () => {
  const srv = toolServer((m) =>
    json(m.id, { content: [{ type: "text", text: JSON.stringify({ page_id: "p1", path: m.params.arguments.path }) }] }),
  );
  const client = new AiMemoryClient({ token: "t", workspace: "demo", project: "app", fetch: srv.fetch });
  const out = await client.writePage("notes/a.md", "# A");
  await client.writePage("notes/b.md", "# B");
  assert.deepEqual(out, { page_id: "p1", path: "notes/a.md" });
  assert.equal(srv.calls.filter((c) => c.message.method === "initialize").length, 1);
  const call = srv.calls.find((c) => c.message.method === "tools/call");
  assert.equal(call.headers.authorization, "Bearer t");
  assert.equal(call.headers["mcp-session-id"], "s-1");
  assert.deepEqual(call.message.params.arguments, { workspace: "demo", project: "app", path: "notes/a.md", body: "# A" });
});

test("global calls do not get the default scope", async () => {
  const srv = toolServer((m) => json(m.id, { content: [{ type: "text", text: "{\"hits\":[]}" }] }));
  const client = new AiMemoryClient({ workspace: "demo", project: "app", fetch: srv.fetch });
  await client.query("x", { global: true });
  const call = srv.calls.find((c) => c.message.method === "tools/call");
  assert.deepEqual(call.message.params.arguments, { global: true, query: "x" });
});

test("result.isError becomes McpToolError", async () => {
  const srv = toolServer((m) => json(m.id, { isError: true, content: [{ type: "text", text: "scope missing" }] }));
  const client = new AiMemoryClient({ fetch: srv.fetch });
  await assert.rejects(client.query("x"), (e) => e instanceof McpToolError && /scope missing/.test(e.message));
});

test("JSON-RPC error becomes McpProtocolError", async () => {
  const srv = toolServer((m) => ({ body: JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "bad params" } }) }));
  const client = new AiMemoryClient({ fetch: srv.fetch });
  await assert.rejects(client.status(), (e) => e instanceof McpProtocolError && e.code === -32602);
});

test("HTTP failure becomes McpHttpError", async () => {
  const srv = fakeServer(() => ({ status: 401, body: "unauthorized" }));
  const client = new AiMemoryClient({ fetch: srv.fetch });
  await assert.rejects(client.status(), (e) => e instanceof McpHttpError && e.status === 401);
});

test("parses an event-stream reply", async () => {
  const srv = toolServer((m) => ({
    body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "{\"hits\":[{\"path\":\"a.md\"}]}" }] } })}\n\n`,
    headers: { "content-type": "text/event-stream" },
  }));
  const client = new AiMemoryClient({ fetch: srv.fetch });
  assert.deepEqual(await client.query("a"), { hits: [{ path: "a.md" }] });
});
