const PROTOCOL_VERSION = "2024-11-05";

/** A JSON-RPC level failure (`error` member on the response). */
export class McpProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

/** A tool ran and reported failure (`result.isError: true`). */
export class McpToolError extends Error {
  constructor(tool, message) {
    super(`${tool}: ${message}`);
    this.name = "McpToolError";
    this.tool = tool;
  }
}

/** A non-2xx HTTP answer from the server. */
export class McpHttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.name = "McpHttpError";
    this.status = status;
    this.body = body;
  }
}

function lastSseData(text) {
  let data = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  return data;
}

function toolPayload(tool, result) {
  const text = (result?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
  if (result?.isError) throw new McpToolError(tool, text || "tool failed");
  if (result?.structuredContent !== undefined) return result.structuredContent;
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class AiMemoryClient {
  /**
   * @param {{ url?: string, token?: string, workspace?: string, project?: string,
   *           fetch?: typeof fetch, clientName?: string }} [options]
   */
  constructor(options = {}) {
    this.url = options.url ?? "http://127.0.0.1:49374/mcp";
    this.token = options.token;
    this.scope = { workspace: options.workspace, project: options.project };
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clientName = options.clientName ?? "ai-memory-client-ts";
    this.sessionId = undefined;
    this.nextId = 1;
    this.initialized = null;
  }

  async #post(message) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const text = await response.text();
    if (!response.ok) throw new McpHttpError(response.status, text);
    if (message.id === undefined || text.trim() === "") return null;
    const contentType = response.headers.get("content-type") ?? "";
    const raw = contentType.includes("text/event-stream") ? lastSseData(text) : text;
    const reply = JSON.parse(raw);
    if (reply.error) {
      throw new McpProtocolError(reply.error.code, reply.error.message, reply.error.data);
    }
    return reply.result;
  }

  async #request(method, params) {
    return this.#post({ jsonrpc: "2.0", id: this.nextId++, method, params });
  }

  /** Run the MCP handshake once; later calls reuse it. */
  initialize() {
    this.initialized ??= (async () => {
      const result = await this.#request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: "0.1.0" },
      });
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
      return result;
    })();
    return this.initialized;
  }

  async listTools() {
    await this.initialize();
    const result = await this.#request("tools/list", {});
    return result?.tools ?? [];
  }

  /** Call any tool. The default workspace/project fill in unless overridden. */
  async callTool(name, args = {}) {
    await this.initialize();
    const scoped = { ...args };
    if (!args.global && args.scope === undefined) {
      if (scoped.workspace === undefined && this.scope.workspace) scoped.workspace = this.scope.workspace;
      if (scoped.project === undefined && this.scope.project) scoped.project = this.scope.project;
    }
    const result = await this.#request("tools/call", { name, arguments: scoped });
    return toolPayload(name, result);
  }

  query(query, args = {}) {
    return this.callTool("memory_query", { ...args, query });
  }

  readPage(path, args = {}) {
    return this.callTool("memory_read_page", { ...args, path });
  }

  writePage(path, body, args = {}) {
    return this.callTool("memory_write_page", { ...args, path, body });
  }

  deletePage(path, args = {}) {
    return this.callTool("memory_delete_page", { ...args, path });
  }

  recent(args = {}) {
    return this.callTool("memory_recent", args);
  }

  handoffBegin(summary, args = {}) {
    return this.callTool("memory_handoff_begin", { ...args, summary });
  }

  handoffList(args = {}) {
    return this.callTool("memory_handoff_list", args);
  }

  handoffAccept(args = {}) {
    return this.callTool("memory_handoff_accept", args);
  }

  handoffCancel(handoffId, args = {}) {
    return this.callTool("memory_handoff_cancel", { ...args, handoff_id: handoffId });
  }

  status(args = {}) {
    return this.callTool("memory_status", args);
  }
}
