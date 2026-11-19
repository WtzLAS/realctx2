/**
 * A minimal MCP server over stdio (JSON-RPC 2.0, one message per line): `initialize`,
 * `tools/list`, `tools/call` and `ping`. Enough to expose realctx2's tools to Claude Code
 * without depending on an SDK.
 */
import type { Readable, Writable } from "node:stream";
import type { JSONSchema } from "../../core/types.ts";
import { REALCTX2_VERSION } from "../../storage/schema.ts";

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JSONSchema;
  readOnly: boolean;
  call(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

interface Request {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

export class McpServer {
  private readonly out: Writable;
  private readonly tools: () => McpTool[];
  private readonly instructions: () => string;
  private buffer = "";
  private closed = false;
  /** Resolves when the client closes the stream. */
  readonly done: Promise<void>;

  constructor(o: { input: Readable; output: Writable; tools: () => McpTool[]; instructions?: () => string }) {
    this.out = o.output;
    this.tools = o.tools;
    this.instructions = o.instructions ?? (() => "");
    this.done = new Promise((resolve) => {
      o.input.setEncoding("utf8");
      o.input.on("data", (chunk: string) => this.feed(chunk));
      o.input.on("end", () => {
        this.closed = true;
        resolve();
      });
      o.input.on("close", () => {
        this.closed = true;
        resolve();
      });
      o.input.on("error", () => resolve());
    });
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Request;
      try {
        msg = JSON.parse(line) as Request;
      } catch {
        this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      void this.handle(msg);
    }
  }

  private send(message: object): void {
    if (this.closed) return;
    try {
      this.out.write(`${JSON.stringify(message)}\n`);
    } catch {
      // the client went away
    }
  }

  private async handle(msg: Request): Promise<void> {
    const id = msg.id;
    const reply = (result: unknown) => id !== undefined && id !== null && this.send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => id !== undefined && id !== null && this.send({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      switch (msg.method) {
        case "initialize": {
          const asked = String(msg.params?.protocolVersion ?? "");
          reply({
            protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "realctx2", title: "realctx2 context and memory", version: REALCTX2_VERSION },
            instructions: this.instructions() || undefined,
          });
          return;
        }
        case "ping":
          reply({});
          return;
        case "tools/list":
          reply({ tools: this.tools().map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: t.readOnly, openWorldHint: false } })) });
          return;
        case "tools/call": {
          const name = String(msg.params?.name ?? "");
          const tool = this.tools().find((t) => t.name === name);
          if (!tool) return void fail(-32602, `Unknown tool: ${name}`);
          const args = (msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {}) as Record<string, unknown>;
          try {
            const res = await tool.call(args);
            reply({ content: [{ type: "text", text: res.text }], isError: res.isError === true });
          } catch (e) {
            reply({ content: [{ type: "text", text: `${name} failed: ${String((e as Error).message ?? e)}` }], isError: true });
          }
          return;
        }
        case "resources/list":
          reply({ resources: [] });
          return;
        case "prompts/list":
          reply({ prompts: [] });
          return;
        default:
          // notifications (no id) need no answer
          if (id !== undefined && id !== null) fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      fail(-32603, String((e as Error).message ?? e));
    }
  }
}
