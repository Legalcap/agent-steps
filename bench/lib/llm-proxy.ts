// A local pass-through to an OpenAI-compatible endpoint (OpenRouter) that counts every model call and its tokens, so a
// cached replay can be checked for "no model call" and its cost added up. It also stops forwarding once the spend
// reaches a budget. It never logs or stores headers: the API key passes through untouched.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface LlmUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** OpenRouter's own figure when it reports one, otherwise tokens times the model's listed price. */
  costUsd: number;
  refused: number;
}

export interface LlmProxy {
  url: string;
  usage(): LlmUsage;
  close(): Promise<void>;
}

const readBody = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

/** `upstream`: e.g. https://openrouter.ai/api/v1. `price`: USD per million prompt and completion tokens. */
export async function startLlmProxy(options: { upstream: string; budgetUsd: number; price: { prompt: number; completion: number } }): Promise<LlmProxy> {
  const total: LlmUsage = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, refused: 0 };
  const upstream = options.upstream.replace(/\/$/u, "");
  const server = createServer(async (request, response) => {
    try {
      if (total.costUsd >= options.budgetUsd) {
        total.refused++;
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "bench budget reached" } }));
        return;
      }
      const body = await readBody(request);
      const headers: Record<string, string> = { "accept-encoding": "identity" };
      for (const name of ["authorization", "content-type", "x-api-key", "anthropic-version", "http-referer", "x-title"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      let json: Record<string, unknown> | null = null;
      try {
        json = body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      // Ask OpenRouter to report the cost of each call.
      const sent = json && typeof json === "object" ? Buffer.from(JSON.stringify({ ...json, usage: { include: true } })) : body;
      const path = (request.url ?? "/").replace(/^\/v1/u, "");
      const answer = await fetch(`${upstream}${path}`, { method: request.method ?? "POST", headers, body: request.method === "GET" ? undefined : new Uint8Array(sent) });
      const text = await answer.text();
      if (request.method !== "GET") {
        total.calls++;
        const usages: Array<Record<string, number>> = [];
        try {
          const parsed = JSON.parse(text) as { usage?: Record<string, number> };
          if (parsed.usage) usages.push(parsed.usage);
        } catch {
          // a streamed answer: the usage rides on the last data line
          for (const line of text.split("\n")) {
            if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
            try {
              const event = JSON.parse(line.slice(5)) as { usage?: Record<string, number> };
              if (event.usage) usages.push(event.usage);
            } catch {
              // not JSON
            }
          }
        }
        const usage = usages.at(-1);
        if (usage) {
          const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
          const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
          total.promptTokens += prompt;
          total.completionTokens += completion;
          total.costUsd += typeof usage.cost === "number" ? usage.cost : (prompt * options.price.prompt + completion * options.price.completion) / 1e6;
        }
      }
      response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
      response.end(text);
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `proxy: ${error instanceof Error ? error.name : "error"}` } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    usage: () => ({ ...total }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
