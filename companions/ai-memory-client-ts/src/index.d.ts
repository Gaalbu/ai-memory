export interface ClientOptions {
  /** MCP endpoint, default `http://127.0.0.1:49374/mcp`. */
  url?: string;
  /** Bearer token (root or database-user key). */
  token?: string;
  /** Default scope; static clients should always set both. */
  workspace?: string;
  project?: string;
  fetch?: typeof fetch;
  clientName?: string;
}

export interface ScopeArgs {
  workspace?: string;
  project?: string;
  [key: string]: unknown;
}

export interface WritePageResult {
  page_id: string;
  path: string;
  [key: string]: unknown;
}

export interface QueryResult {
  hits: Array<{ path: string; title?: string; snippet?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export declare class McpProtocolError extends Error {
  code: number;
  data?: unknown;
}

export declare class McpToolError extends Error {
  tool: string;
}

export declare class McpHttpError extends Error {
  status: number;
  body: string;
}

export declare class AiMemoryClient {
  constructor(options?: ClientOptions);
  sessionId: string | undefined;
  initialize(): Promise<unknown>;
  listTools(): Promise<McpTool[]>;
  callTool<T = unknown>(name: string, args?: ScopeArgs): Promise<T>;
  query(query: string, args?: ScopeArgs): Promise<QueryResult>;
  readPage(path: string, args?: ScopeArgs): Promise<unknown>;
  writePage(path: string, body: string, args?: ScopeArgs): Promise<WritePageResult>;
  deletePage(path: string, args?: ScopeArgs): Promise<unknown>;
  recent(args?: ScopeArgs): Promise<unknown>;
  handoffBegin(summary: string, args?: ScopeArgs): Promise<unknown>;
  handoffList(args?: ScopeArgs): Promise<unknown>;
  handoffAccept(args?: ScopeArgs): Promise<unknown>;
  handoffCancel(handoffId: string, args?: ScopeArgs): Promise<unknown>;
  status(args?: ScopeArgs): Promise<unknown>;
}
