// src/ui/server.ts
import { join } from "path";
import type { WorkerState } from "./state.ts";
import { readConfigFile, writeConfigFile } from "./config-api.ts";

const PUBLIC_DIR = join(import.meta.dir, "public");

export interface UiServerOptions {
  state: WorkerState;
  configPath: string;
  port?: number;
  host?: string;
  token?: string;
  controls?: {
    startWorker?: () => void;
    stopWorker?: () => void;
    cancelJob?: () => void;
  };
}

function isMutating(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
}

function checkAuth(req: Request, token?: string): Response | null {
  if (!token) return null;
  if (isMutating(req.method)) {
    if (req.headers.get("X-UI-Token") !== token) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return null;
}

export function startUiServer(options: UiServerOptions): { stop(): void } {
  const { state, configPath, port = 3030, host = "127.0.0.1", token, controls } = options;

  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.warn(`[ui] WARNING: UI server bound to ${host} — consider setting ui.token for access control`);
  }

  // SSE clients: each connected browser registers a controller to push chunks into.
  // We subscribe once to WorkerState and fan out to all connected clients.
  const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const unsubscribe = state.subscribe((event) => {
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const ctrl of sseControllers) {
      try { ctrl.enqueue(chunk); } catch { sseControllers.delete(ctrl); }
    }
  });

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Auth check for mutating routes
      const authError = checkAuth(req, token);
      if (authError) return authError;

      // Static files
      if (pathname === "/" || pathname === "/index.html") {
        const file = Bun.file(join(PUBLIC_DIR, "index.html"));
        return new Response(file);
      }
      if (pathname.startsWith("/public/")) {
        const filePath = join(PUBLIC_DIR, pathname.slice("/public/".length));
        if (!filePath.startsWith(PUBLIC_DIR + "/")) {
          return new Response("Forbidden", { status: 403 });
        }
        const file = Bun.file(filePath);
        return new Response(file);
      }

      // API routes
      if (pathname === "/api/state" && req.method === "GET") {
        return Response.json(state.getSnapshot());
      }

      if (pathname === "/api/events" && req.method === "GET") {
        let capturedController: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            capturedController = controller;
            sseControllers.add(controller);
            // Initial heartbeat so the browser's EventSource confirms the connection
            controller.enqueue(encoder.encode(`: connected\n\n`));
            // Send initial state snapshot asynchronously so it arrives as a separate network chunk
            setTimeout(() => {
              try {
                const snapshot = state.getSnapshot();
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "snapshot", ...snapshot })}\n\n`));
              } catch { /* controller may have been cancelled */ }
            }, 0);
          },
          cancel() {
            if (capturedController) {
              sseControllers.delete(capturedController);
              capturedController = null;
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      if (pathname === "/api/config" && req.method === "GET") {
        // Protect config reads with token auth too — config may contain sensitive fields
        if (token && req.headers.get("X-UI-Token") !== token) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const config = readConfigFile(configPath);
          return Response.json(config);
        } catch {
          return Response.json({ error: "Failed to read config" }, { status: 500 });
        }
      }

      if (pathname === "/api/config" && req.method === "PUT") {
        try {
          const body = await req.json() as unknown;
          writeConfigFile(configPath, body);
          state.notifyConfigUpdate();
          return Response.json({ ok: true });
        } catch (err) {
          if (err && typeof err === "object" && "issues" in err) {
            return Response.json({ ok: false, errors: (err as { issues: unknown[] }).issues }, { status: 400 });
          }
          return new Response("Internal server error", { status: 500 });
        }
      }

      if (pathname === "/api/worker/start" && req.method === "POST") {
        const snapshot = state.getSnapshot();
        if (snapshot.workerStatus !== "running") {
          controls?.startWorker?.();
        }
        return Response.json({ ok: true });
      }

      if (pathname === "/api/worker/stop" && req.method === "POST") {
        controls?.stopWorker?.();
        return Response.json({ ok: true });
      }

      if (pathname === "/api/job/cancel" && req.method === "POST") {
        controls?.cancelJob?.();
        return Response.json({ ok: true });
      }

      if (pathname === "/api/job/dismiss" && req.method === "POST") {
        state.dismissJob();
        return Response.json({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    stop() {
      unsubscribe();
      server.stop(true);
    },
  };
}
