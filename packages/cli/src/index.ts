import WebSocket from "ws";
import { type IPty } from "node-pty";
import {
  generateKey,
  importKey,
  encrypt,
  decrypt,
  toBase64Url,
  frameMessage,
  parseFrame,
} from "@fied/crypto";
import { listSessions, attachSession } from "./tmux.js";
import { addSession, removeSession } from "./store.js";

const DEFAULT_RELAY = "https://fied.app";

const MSG_TERMINAL_OUTPUT = 0x01;
const MSG_TERMINAL_INPUT = 0x02;
const MSG_RESIZE = 0x03;

const RESIZE_MIN_COLS = 20;
const RESIZE_MAX_COLS = 1000;
const RESIZE_MIN_ROWS = 5;
const RESIZE_MAX_ROWS = 300;
const MAX_INVALID_RESIZE_FRAMES = 5;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

type RelayTarget = {
  httpBase: URL;
  wsBase: URL;
};

export interface FiedOptions {
  session?: string;
  relay?: string;
  cols?: number;
  rows?: number;
  background?: boolean;
  allowInsecureRelay?: boolean;
}

export async function share(options: FiedOptions): Promise<void> {
  const relayTarget = parseRelayTarget(
    options.relay ?? DEFAULT_RELAY,
    options.allowInsecureRelay ?? process.env.FIED_ALLOW_INSECURE_RELAY === "1",
  );

  const sessions = listSessions();
  if (sessions.length === 0) {
    console.error("No tmux sessions found. Start one with: tmux new -s mysession");
    process.exit(1);
  }

  let targetSession: string;
  if (options.session) {
    const found = sessions.find(
      (s) => s.name === options.session || s.id === options.session
    );
    if (!found) {
      console.error(`tmux session "${options.session}" not found.`);
      process.exit(1);
    }
    targetSession = found.name;
  } else if (sessions.length === 1) {
    targetSession = sessions[0].name;
  } else {
    console.error("Multiple tmux sessions found. Specify one with --session:");
    process.exit(1);
  }

  const cols = options.cols ?? process.stdout.columns ?? 80;
  const rows = options.rows ?? process.stdout.rows ?? 24;

  const rawKey = await generateKey();
  const cryptoKey = await importKey(rawKey);
  const keyFragment = toBase64Url(rawKey);

  const pty = attachSession(targetSession, cols, rows);

  if (!options.background) {
    console.log("");
    console.log("  \x1b[1m\x1b[32mfied\x1b[0m — encrypted terminal sharing");
    console.log("");
    console.log(`  Session:  ${targetSession}`);
    console.log(`  Size:     ${cols}x${rows}`);
    console.log("");
  }

  const bridge = new RelayBridge(relayTarget, cryptoKey, keyFragment, pty, options.background);

  const onUrl = (url: string) => {
    if (options.background) {
      addSession({
        pid: process.pid,
        tmuxSession: targetSession,
        url,
        relay: relayTarget.httpBase.toString(),
        startedAt: new Date().toISOString(),
      });
    }
  };

  await bridge.connect(onUrl);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    bridge.destroy();
    try {
      pty.kill();
    } catch {
    }
    if (options.background) {
      removeSession(process.pid);
    }
  };

  const exitNow = (code: number) => {
    cleanup();
    process.exit(code);
  };

  process.once("SIGINT", () => exitNow(0));
  process.once("SIGTERM", () => exitNow(0));

  await new Promise<void>((resolve) => {
    pty.onExit(() => {
      cleanup();
      resolve();
    });
  });
}

function parseRelayTarget(relay: string, allowInsecureRelay: boolean): RelayTarget {
  let parsed: URL;
  try {
    parsed = new URL(relay);
  } catch {
    throw new Error(`Invalid relay URL: ${relay}`);
  }

  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";

  if (!isHttps) {
    if (!(isHttp && isLocalhost && allowInsecureRelay)) {
      throw new Error(
        "Relay must use https://. For local development, use http://localhost with --allow-insecure-relay or FIED_ALLOW_INSECURE_RELAY=1",
      );
    }
  }

  const httpBase = new URL(parsed.toString());
  httpBase.hash = "";
  httpBase.search = "";
  if (!httpBase.pathname.endsWith("/")) {
    httpBase.pathname = `${httpBase.pathname}/`;
  }

  const wsBase = new URL(httpBase.toString());
  wsBase.protocol = httpBase.protocol === "https:" ? "wss:" : "ws:";

  return { httpBase, wsBase };
}

async function createSession(relayHttpBase: URL): Promise<string> {
  const url = new URL("api/sessions", relayHttpBase);
  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

const WS_CONNECT_TIMEOUT_MS = 10_000;

class RelayBridge {
  private ws: WebSocket | null = null;
  private destroyed = false;
  private backoff = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private sessionId: string | null = null;
  private onUrl: ((url: string) => void) | null = null;
  private invalidResizeFrames = 0;

  constructor(
    private relayTarget: RelayTarget,
    private key: CryptoKey,
    private keyFragment: string,
    private pty: IPty,
    private silent = false,
  ) {
    this.pty.onData((data: string) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendEncrypted(MSG_TERMINAL_OUTPUT, this.encoder.encode(data));
      }
    });
  }

  async connect(onUrl?: (url: string) => void): Promise<void> {
    if (this.destroyed) return;

    if (onUrl) {
      this.onUrl = onUrl;
    }

    if (!this.sessionId) {
      try {
        this.sessionId = await createSession(this.relayTarget.httpBase);
      } catch {
        if (!this.silent) console.error("  \x1b[31mRelay unreachable, retrying...\x1b[0m");
        this.scheduleReconnect();
        return;
      }

      const shareUrl = new URL(`s/${this.sessionId}`, this.relayTarget.httpBase);
      const url = `${shareUrl.toString()}#${this.keyFragment}`;
      this.onUrl?.(url);

      if (!this.silent) {
        console.log(`  \x1b[1mShare this link:\x1b[0m`);
        console.log(`  \x1b[4m\x1b[36m${url}\x1b[0m`);
        console.log("");
        console.log("  \x1b[2mThe encryption key is in the URL fragment (#) — the server never sees it.\x1b[0m");
        console.log("  \x1b[2mPress Ctrl+C to stop sharing.\x1b[0m");
        console.log("");
      }
    }

    const wsUrl = new URL(`api/sessions/${this.sessionId}/ws`, this.relayTarget.wsBase);
    wsUrl.searchParams.set("role", "host");
    const ws = new WebSocket(wsUrl.toString());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    this.connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.terminate();
      }
    }, WS_CONNECT_TIMEOUT_MS);

    ws.on("open", () => {
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.backoff = RECONNECT_BASE_MS;
    });

    ws.on("message", async (raw: ArrayBuffer, isBinary: boolean) => {
      if (!isBinary) {
        const text = this.decoder.decode(raw);
        if (text === "__fied_ping__") {
          ws.send("__fied_pong__");
        }
        return;
      }

      try {
        const data = new Uint8Array(raw);
        const frame = parseFrame(data);

        if (frame.type === MSG_TERMINAL_INPUT) {
          const plaintext = await decrypt(this.key, frame.iv, frame.ciphertext);
          this.pty.write(this.decoder.decode(plaintext));
        } else if (frame.type === MSG_RESIZE) {
          const plaintext = await decrypt(this.key, frame.iv, frame.ciphertext);
          const resize = parseResizePayload(this.decoder.decode(plaintext));
          if (!resize) {
            this.invalidResizeFrames += 1;
            if (this.invalidResizeFrames >= MAX_INVALID_RESIZE_FRAMES) {
              ws.close(1008, "invalid resize frames");
            }
            return;
          }

          this.invalidResizeFrames = 0;
          this.pty.resize(resize.cols, resize.rows);
        }
      } catch (err) {
        if (!this.silent) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`  \x1b[33mIncoming frame rejected:\x1b[0m ${detail}`);
        }
      }
    });

    ws.on("close", () => {
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.ws = null;
      if (!this.destroyed) {
        if (!this.silent) console.error("  \x1b[33mConnection lost, reconnecting...\x1b[0m");
        this.scheduleReconnect();
      }
    });

    ws.on("error", () => {});
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);

    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
  }

  private async sendEncrypted(type: number, plaintext: Uint8Array): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const { iv, ciphertext } = await encrypt(this.key, plaintext);
      const frame = frameMessage(type, iv, ciphertext);
      this.ws.send(frame);
    } catch (err) {
      if (!this.silent) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`  \x1b[33mEncryption failed:\x1b[0m ${detail}`);
      }
    }
  }
}

function parseResizePayload(payload: string): { cols: number; rows: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const typed = parsed as { cols?: unknown; rows?: unknown };
  if (!Number.isInteger(typed.cols) || !Number.isInteger(typed.rows)) return null;

  const cols = typed.cols as number;
  const rows = typed.rows as number;
  if (cols < RESIZE_MIN_COLS || cols > RESIZE_MAX_COLS) return null;
  if (rows < RESIZE_MIN_ROWS || rows > RESIZE_MAX_ROWS) return null;

  return { cols, rows };
}
