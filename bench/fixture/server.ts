// A tiny HTTP server for the fixture site. One run at a time: `reset(task, variant)` picks what every page shows and
// clears the event log the ground truth is judged from.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { makeCtx, shell, taskById, type BenchEvent, type RunState, type Task, type Variant } from "./site.ts";

export interface FixtureServer {
  url: string;
  reset(task: string, variant: Variant): void;
  events(): BenchEvent[];
  close(): Promise<void>;
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

export async function startFixture(port = 0): Promise<FixtureServer> {
  let task: Task | undefined;
  let variant: Variant = "base";
  let state: RunState = { events: [], data: {} };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture.local");
      const send = (status: number, body: string, type = "text/html; charset=utf-8") => {
        response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
        response.end(body);
      };
      if (url.pathname === "/__bench/event" && request.method === "POST") {
        state.events.push(JSON.parse(await readBody(request)) as BenchEvent);
        return send(204, "");
      }
      if (url.pathname === "/__bench/state") return send(200, JSON.stringify({ task: task?.id, variant, events: state.events }), "application/json");
      if (url.pathname === "/__bench/reset" && request.method === "POST") {
        const { task: id, variant: next } = JSON.parse(await readBody(request)) as { task: string; variant: Variant };
        reset(id, next);
        return send(204, "");
      }
      if (url.pathname === "/favicon.ico") return send(404, "");
      const owner = task && url.pathname.startsWith(task.prefix) ? task : undefined;
      if (!owner) return send(404, "<h1>Not found</h1><p>No task is active for this page.</p>");
      const ctx = makeCtx(owner, variant);
      if (request.method === "POST" && owner.post) {
        const next = owner.post(url.pathname, new URLSearchParams(await readBody(request)), ctx, state);
        response.writeHead(303, { location: next, "cache-control": "no-store" });
        return response.end();
      }
      const page = owner.render(url.pathname, url.searchParams, ctx, state);
      return page ? send(200, shell(ctx, page)) : send(404, "<h1>Not found</h1>");
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });

  function reset(id: string, next: Variant) {
    const found = taskById(id);
    if (!found) throw new Error(`no task ${id}`);
    task = found;
    variant = next;
    state = { events: [], data: {} };
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    reset,
    events: () => [...state.events],
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** `node bench/fixture/server.ts [port] [task] [variant]`: serve the site for a look in a browser. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startFixture(Number(process.argv[2] ?? 4173));
  fixture.reset(process.argv[3] ?? "invites", (process.argv[4] ?? "base") as Variant);
  process.stdout.write(`fixture at ${fixture.url} (POST /__bench/reset {task, variant} to switch)\n`);
}
