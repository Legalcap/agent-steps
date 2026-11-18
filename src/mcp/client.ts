// A small MCP client over a child process's stdio: newline-delimited JSON-RPC, enough for tools/list and tools/call.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Caller, CallOutcome } from "../types.ts";
import { MCP_PROTOCOL, VERSION } from "../version.ts";

export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export interface StdioMcpClientOptions {
  /** How long one request may take before it fails (5 minutes by default), so a server that hangs never hangs its caller. */
  timeoutMs?: number;
}

export const REQUEST_TIMEOUT_MS = 5 * 60_000;
const STDERR_KEPT = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A tools/call answer as a CallOutcome: structured content, the text parts, or the error it reported. */
export function callOutcome(result: unknown): CallOutcome {
  if (!isRecord(result) || !Array.isArray(result.content)) return { ok: false, error: "the tool returned an invalid result" };
  const text = result.content.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
  if (result.isError === true) return { ok: false, error: text.trim().slice(0, 300) || "the tool reported an error" };
  const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
  if (structured.refusal !== undefined && structured.refusal !== null) return { ok: false, error: "the tool refused the call" };
  return { ok: true, structured, ...(text ? { text } : {}) };
}

export class StdioMcpClient implements Caller {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  /** Why no further request can be answered: the child exited or could not start. */
  private gone: Error | null = null;

  constructor(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, options: StdioMcpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-STDERR_KEPT); });
    // A write to a child that has gone reports here; the exit handler already failed what was waiting.
    this.child.stdin.on("error", () => {});
    this.child.on("exit", () => this.end(new Error(`${command} exited${this.lastWords()}`)));
    this.child.on("error", (error) => this.end(error));
  }

  async start(): Promise<void> {
    await this.request("initialize", { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "agent-steps", version: VERSION } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async tools(): Promise<McpTool[]> {
    const listed = await this.request("tools/list", {});
    return isRecord(listed) && Array.isArray(listed.tools) ? listed.tools.filter((tool): tool is McpTool => isRecord(tool) && typeof tool.name === "string") : [];
  }

  /** The raw tools/call result, as the server answered it. */
  callRaw(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallOutcome> {
    try {
      return callOutcome(await this.callRaw(tool, args, signal));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }

  private lastWords(): string {
    const line = this.stderr.trim().split("\n").at(-1)?.trim();
    return line ? `: ${line.slice(0, 300)}` : "";
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.gone) return reject(this.gone);
      if (signal?.aborted) return reject(new Error("stopped"));
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        this.pending.delete(id);
      };
      // Tells the server too, so it stops working on a request nobody waits for.
      const abandon = (why: string) => {
        settle();
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: why } })}\n`);
        reject(new Error(why));
      };
      const stop = () => abandon("stopped");
      const timer = setTimeout(() => abandon(`${method} timed out after ${this.timeoutMs} ms`), this.timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      this.pending.set(id, {
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(frame) || typeof frame.id !== "number") continue;
      const waiting = this.pending.get(frame.id);
      if (!waiting) continue;
      if (isRecord(frame.error)) waiting.reject(new Error(typeof frame.error.message === "string" ? frame.error.message : "the server reported an error"));
      else waiting.resolve(frame.result);
    }
  }

  private end(error: Error): void {
    this.gone ??= error;
    for (const waiting of this.pending.values()) waiting.reject(this.gone);
  }
}
