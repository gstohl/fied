import { DurableObject } from "cloudflare:workers";

interface Env {
  SESSION: DurableObjectNamespace<Session>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  ASSETS: Fetcher;
  MAX_VIEWERS_PER_SESSION?: string;
}

type Role = "host" | "viewer";

type SocketMeta = {
  role: Role;
  id: string;
};

type SocketRateState = {
  tokens: number;
  lastRefillAt: number;
};

type HeartbeatState = {
  awaitingPong: boolean;
  lastPingAt: number;
};

const SESSION_ID_BYTES = 12;
const SESSION_HARD_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_PING = "__fied_ping__";
const HEARTBEAT_PONG = "__fied_pong__";
const VIEWER_JOINED = "__fied_viewer_joined__";
const MAX_FRAME_BYTES = 64 * 1024;
const REPLAY_BUFFER_MAX_BYTES = 256 * 1024;
const REPLAY_BUFFER_MAX_FRAMES = 32;
const SOCKET_BUCKET_BURST = 120;
const SOCKET_BUCKET_REFILL_PER_SECOND = 60;
const SESSION_CREATE_BUCKET_BURST = 20;
const SESSION_CREATE_BUCKET_REFILL_PER_SECOND = 10 / 60;
const RATE_LIMITER_SWEEP_INTERVAL_MS = 60_000;
const RATE_LIMITER_STALE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_VIEWERS_PER_SESSION = 5;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
].join("; ");

const EDGE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function securityHeaders(contentType: string): Headers {
  const headers = new Headers({
    ...EDGE_SECURITY_HEADERS,
    "content-type": contentType,
  });
  if (contentType.includes("text/html")) {
    headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  }
  return headers;
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(EDGE_SECURITY_HEADERS)) {
    headers.set(key, value);
  }

  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders("application/json; charset=utf-8"),
  });
}

function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: securityHeaders("text/html; charset=utf-8"),
  });
}

function text(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: securityHeaders("text/plain; charset=utf-8"),
  });
}

function parseClientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export class Session extends DurableObject<Env> {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeat = new Map<WebSocket, HeartbeatState>();
  private socketRate = new Map<WebSocket, SocketRateState>();
  private createdAt: number | null = null;
  private lastActivityAt: number | null = null;
  private lastPersistedAt = 0;
  private recentHostFrames: ArrayBuffer[] = [];
  private recentHostFrameBytes = 0;
  private maxViewersPerSession = DEFAULT_MAX_VIEWERS_PER_SESSION;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const parsedLimit = Number.parseInt(env.MAX_VIEWERS_PER_SESSION ?? "", 10);
    if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
      this.maxViewersPerSession = parsedLimit;
    }
    this.initializeHeartbeatState();
    this.startHeartbeat();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/init" && request.method === "POST") {
      const now = Date.now();
      this.createdAt = now;
      this.lastActivityAt = now;
      this.lastPersistedAt = now;
      await this.ctx.storage.put({ created: true, createdAt: now, lastActivityAt: now });
      return text("ok", 201);
    }

    if (url.pathname === "/internal/ws" && request.method === "GET") {
      const created = await this.ctx.storage.get<boolean>("created");
      if (!created) {
        return text("session not found", 404);
      }

      await this.loadSessionState();
      if (this.isExpired(Date.now())) {
        await this.expireSession("session expired");
        return text("session expired", 410);
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
      if (role === "viewer") {
        const viewerCount = sockets.filter((socket) => this.getSocketMeta(socket)?.role === "viewer").length;
        if (viewerCount >= this.maxViewersPerSession) {
          return text("viewer limit reached", 429);
        }
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      const meta: SocketMeta = { role, id: crypto.randomUUID() };
      server.serializeAttachment(meta);
      this.ctx.acceptWebSocket(server);
      this.heartbeat.set(server, { awaitingPong: false, lastPingAt: Date.now() });
      this.socketRate.set(server, { tokens: SOCKET_BUCKET_BURST, lastRefillAt: Date.now() });
      this.touchActivity(Date.now());

      if (role === "viewer") {
        this.replayRecentFrames(server);

        const sockets = this.ctx.getWebSockets();
        const host = sockets.find((socket) => this.getSocketMeta(socket)?.role === "host");
        if (host) {
          host.send(VIEWER_JOINED);
        }
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return text("not found", 404);
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    const now = Date.now();
    if (this.isExpired(now)) {
      ws.close(1008, "session expired");
      void this.expireSession("session expired");
      return;
    }

    if (!this.consumeSocketToken(ws, now)) {
      ws.close(1013, "rate limit exceeded");
      return;
    }

    if (typeof message === "string") {
      if (new TextEncoder().encode(message).byteLength > MAX_FRAME_BYTES) {
        ws.close(1009, "frame too large");
        return;
      }
      if (message === HEARTBEAT_PONG) {
        const state = this.heartbeat.get(ws);
        if (state) {
          state.awaitingPong = false;
        }
        this.touchActivity(now);
      }
      return;
    }

    if (message.byteLength > MAX_FRAME_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }

    const meta = this.getSocketMeta(ws);
    if (!meta) {
      ws.close(1011, "missing metadata");
      return;
    }

    if (meta.role === "host") {
      this.bufferHostFrame(message);

      for (const viewer of this.ctx.getWebSockets()) {
        const viewerMeta = this.getSocketMeta(viewer);
        if (viewerMeta?.role === "viewer") {
          viewer.send(message);
        }
      }
      this.touchActivity(now);
      return;
    }

    const host = this.ctx.getWebSockets().find((socket) => this.getSocketMeta(socket)?.role === "host");
    if (host) {
      host.send(message);
    }
    this.touchActivity(now);
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
    this.socketRate.delete(ws);

    if (meta?.role === "host") {
      this.clearReplayBuffer();

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

      if (this.isExpired(now)) {
        void this.expireSession("session expired");
        return;
      }

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

  private async loadSessionState(): Promise<void> {
    if (this.createdAt !== null && this.lastActivityAt !== null) {
      return;
    }

    const [createdAt, lastActivityAt] = await Promise.all([
      this.ctx.storage.get<number>("createdAt"),
      this.ctx.storage.get<number>("lastActivityAt"),
    ]);

    this.createdAt = createdAt ?? null;
    this.lastActivityAt = lastActivityAt ?? null;
  }

  private isExpired(now: number): boolean {
    if (this.createdAt === null || this.lastActivityAt === null) {
      return false;
    }

    if (now - this.createdAt > SESSION_HARD_TTL_MS) {
      return true;
    }

    if (now - this.lastActivityAt > SESSION_IDLE_TTL_MS) {
      return true;
    }

    return false;
  }

  private touchActivity(now: number): void {
    this.lastActivityAt = now;
    if (now - this.lastPersistedAt < 1000) {
      return;
    }
    this.lastPersistedAt = now;
    void this.ctx.storage.put("lastActivityAt", now);
  }

  private consumeSocketToken(ws: WebSocket, now: number): boolean {
    let state = this.socketRate.get(ws);
    if (!state) {
      state = { tokens: SOCKET_BUCKET_BURST, lastRefillAt: now };
      this.socketRate.set(ws, state);
    }

    const elapsedMs = now - state.lastRefillAt;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * SOCKET_BUCKET_REFILL_PER_SECOND;
      state.tokens = Math.min(SOCKET_BUCKET_BURST, state.tokens + refill);
      state.lastRefillAt = now;
    }

    if (state.tokens < 1) {
      return false;
    }

    state.tokens -= 1;
    return true;
  }

  private async expireSession(reason: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1008, reason);
      this.heartbeat.delete(socket);
      this.socketRate.delete(socket);
    }

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.createdAt = null;
    this.lastActivityAt = null;
    this.lastPersistedAt = 0;
    this.clearReplayBuffer();
    await this.ctx.storage.deleteAll();
  }

  private bufferHostFrame(frame: ArrayBuffer): void {
    const copy = frame.slice(0);
    this.recentHostFrames.push(copy);
    this.recentHostFrameBytes += copy.byteLength;

    while (
      this.recentHostFrames.length > REPLAY_BUFFER_MAX_FRAMES ||
      this.recentHostFrameBytes > REPLAY_BUFFER_MAX_BYTES
    ) {
      const dropped = this.recentHostFrames.shift();
      if (!dropped) {
        break;
      }
      this.recentHostFrameBytes -= dropped.byteLength;
    }
  }

  private replayRecentFrames(viewer: WebSocket): void {
    for (const frame of this.recentHostFrames) {
      viewer.send(frame);
    }
  }

  private clearReplayBuffer(): void {
    this.recentHostFrames = [];
    this.recentHostFrameBytes = 0;
  }
}

type IpBucketState = {
  tokens: number;
  lastRefillAt: number;
};

export class RateLimiter extends DurableObject {
  private buckets = new Map<string, IpBucketState>();
  private lastSweepAt = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/internal/check" || request.method !== "POST") {
      return text("not found", 404);
    }

    const body = (await request.json()) as { key?: unknown };
    if (typeof body.key !== "string" || body.key.length === 0) {
      return text("invalid key", 400);
    }

    const allowed = this.consumeToken(body.key, Date.now());
    return json({ allowed }, allowed ? 200 : 429);
  }

  private consumeToken(key: string, now: number): boolean {
    this.sweepStale(now);

    let state = this.buckets.get(key);
    if (!state) {
      state = { tokens: SESSION_CREATE_BUCKET_BURST, lastRefillAt: now };
      this.buckets.set(key, state);
    }

    const elapsedMs = now - state.lastRefillAt;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * SESSION_CREATE_BUCKET_REFILL_PER_SECOND;
      state.tokens = Math.min(SESSION_CREATE_BUCKET_BURST, state.tokens + refill);
      state.lastRefillAt = now;
    }

    if (state.tokens < 1) {
      return false;
    }

    state.tokens -= 1;
    return true;
  }

  private sweepStale(now: number): void {
    if (now - this.lastSweepAt < RATE_LIMITER_SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;

    for (const [key, state] of this.buckets) {
      if (now - state.lastRefillAt > RATE_LIMITER_STALE_MS) {
        this.buckets.delete(key);
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const limiterId = env.RATE_LIMITER.idFromName("session-create-limiter");
      const limiter = env.RATE_LIMITER.get(limiterId);
      const limiterResponse = await limiter.fetch("https://limiter/internal/check", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ key: parseClientIp(request) }),
      });
      if (limiterResponse.status === 429) {
        return text("too many session creations", 429);
      }

      const sessionId = randomSessionId();
      const id = env.SESSION.idFromName(sessionId);
      const stub = env.SESSION.get(id);
      await stub.fetch("https://session/internal/init", { method: "POST" });
      return json({ sessionId }, 201);
    }

    const wsRoute = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{8,64})\/ws$/);
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

    const assetResponse = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetResponse);
  },
};
