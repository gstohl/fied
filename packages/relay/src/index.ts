import { DurableObject } from "cloudflare:workers";

interface Env {
  SESSION: DurableObjectNamespace<Session>;
}

type Role = "host" | "viewer";

type SocketMeta = {
  role: Role;
  id: string;
};

type HeartbeatState = {
  awaitingPong: boolean;
  lastPingAt: number;
};

const SESSION_ID_LENGTH = 8;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_PING = "__fied_ping__";
const HEARTBEAT_PONG = "__fied_pong__";

function randomSessionId(): string {
  return crypto.randomUUID().replace(/[^a-zA-Z0-9]/g, "").slice(0, SESSION_ID_LENGTH);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function text(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export class Session extends DurableObject<Env> {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeat = new Map<WebSocket, HeartbeatState>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initializeHeartbeatState();
    this.startHeartbeat();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/init" && request.method === "POST") {
      await this.ctx.storage.put("created", true);
      return text("ok", 201);
    }

    if (url.pathname === "/internal/ws" && request.method === "GET") {
      const created = await this.ctx.storage.get<boolean>("created");
      if (!created) {
        return text("session not found", 404);
      }

      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "viewer") {
        return text("invalid role", 400);
      }

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return text("expected websocket", 426);
      }

      const sockets = this.ctx.getWebSockets();
      if (role === "host" && sockets.some((socket) => this.getSocketMeta(socket)?.role === "host")) {
        return text("host already connected", 409);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      const meta: SocketMeta = { role, id: crypto.randomUUID() };
      server.serializeAttachment(meta);
      this.ctx.acceptWebSocket(server);
      this.heartbeat.set(server, { awaitingPong: false, lastPingAt: Date.now() });

      return new Response(null, { status: 101, webSocket: client });
    }

    return text("not found", 404);
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    if (typeof message === "string") {
      if (message === HEARTBEAT_PONG) {
        const state = this.heartbeat.get(ws);
        if (state) {
          state.awaitingPong = false;
        }
      }
      return;
    }

    const meta = this.getSocketMeta(ws);
    if (!meta) {
      ws.close(1011, "missing metadata");
      return;
    }

    if (meta.role === "host") {
      for (const viewer of this.ctx.getWebSockets()) {
        const viewerMeta = this.getSocketMeta(viewer);
        if (viewerMeta?.role === "viewer") {
          viewer.send(message);
        }
      }
      return;
    }

    const host = this.ctx.getWebSockets().find((socket) => this.getSocketMeta(socket)?.role === "host");
    if (host) {
      host.send(message);
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.cleanupSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.cleanupSocket(ws);
  }

  private cleanupSocket(ws: WebSocket): void {
    const meta = this.getSocketMeta(ws);
    this.heartbeat.delete(ws);

    if (meta?.role === "host") {
      for (const socket of this.ctx.getWebSockets()) {
        if (socket !== ws && this.getSocketMeta(socket)?.role === "viewer") {
          socket.close(1012, "host disconnected");
        }
      }
    }
  }

  private initializeHeartbeatState(): void {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      this.heartbeat.set(socket, { awaitingPong: false, lastPingAt: now });
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const socket of this.ctx.getWebSockets()) {
        if (!this.heartbeat.has(socket)) {
          this.heartbeat.set(socket, { awaitingPong: false, lastPingAt: now });
        }

        const state = this.heartbeat.get(socket);
        if (!state) {
          continue;
        }

        if (state.awaitingPong) {
          if (now - state.lastPingAt > HEARTBEAT_TIMEOUT_MS) {
            socket.close(1001, "heartbeat timeout");
            this.heartbeat.delete(socket);
          }
          continue;
        }

        socket.send(HEARTBEAT_PING);
        state.awaitingPong = true;
        state.lastPingAt = now;
      }

      for (const socket of [...this.heartbeat.keys()]) {
        if (!this.ctx.getWebSockets().includes(socket)) {
          this.heartbeat.delete(socket);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private getSocketMeta(socket: WebSocket): SocketMeta | null {
    const meta = socket.deserializeAttachment();
    if (!meta || typeof meta !== "object") {
      return null;
    }

    const typedMeta = meta as Partial<SocketMeta>;
    if ((typedMeta.role !== "host" && typedMeta.role !== "viewer") || typeof typedMeta.id !== "string") {
      return null;
    }

    return { role: typedMeta.role, id: typedMeta.id };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const sessionId = randomSessionId();
      const id = env.SESSION.idFromName(sessionId);
      const stub = env.SESSION.get(id);
      await stub.fetch("https://session/internal/init", { method: "POST" });
      return json({ sessionId }, 201);
    }

    const wsRoute = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9]{1,64})\/ws$/);
    if (request.method === "GET" && wsRoute) {
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "viewer") {
        return text("invalid role", 400);
      }

      const sessionId = wsRoute[1];
      const id = env.SESSION.idFromName(sessionId);
      const stub = env.SESSION.get(id);
      const doUrl = new URL("https://session/internal/ws");
      doUrl.searchParams.set("role", role);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return text("not found", 404);
  },
};
