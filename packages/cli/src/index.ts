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

const DEFAULT_RELAY = "https://fied.app";

const MSG_TERMINAL_OUTPUT = 0x01;
const MSG_TERMINAL_INPUT = 0x02;
const MSG_RESIZE = 0x03;

export interface FiedOptions {
  session?: string;
  relay?: string;
  cols?: number;
  rows?: number;
}

export async function share(options: FiedOptions): Promise<void> {
  const relay = options.relay ?? DEFAULT_RELAY;

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
      console.error("Available sessions:");
      for (const s of sessions) {
        console.error(`  ${s.name} (${s.windows} windows${s.attached ? ", attached" : ""})`);
      }
      process.exit(1);
    }
    targetSession = found.name;
  } else if (sessions.length === 1) {
    targetSession = sessions[0].name;
  } else {
    console.error("Multiple tmux sessions found. Specify one with --session:");
    for (const s of sessions) {
      console.error(`  ${s.name} (${s.windows} windows${s.attached ? ", attached" : ""})`);
    }
    process.exit(1);
  }

  const cols = options.cols ?? process.stdout.columns ?? 80;
  const rows = options.rows ?? process.stdout.rows ?? 24;

  const rawKey = await generateKey();
  const cryptoKey = await importKey(rawKey);
  const keyFragment = toBase64Url(rawKey);

  const sessionId = await createSession(relay);

  const url = `${relay}/s/${sessionId}#${keyFragment}`;
  console.log("");
  console.log("  \x1b[1m\x1b[32mfied\x1b[0m — encrypted terminal sharing");
  console.log("");
  console.log(`  Session:  ${targetSession}`);
  console.log(`  Size:     ${cols}x${rows}`);
  console.log("");
  console.log(`  \x1b[1mShare this link:\x1b[0m`);
  console.log(`  \x1b[4m\x1b[36m${url}\x1b[0m`);
  console.log("");
  console.log("  \x1b[2mThe encryption key is in the URL fragment (#) — the server never sees it.\x1b[0m");
  console.log("  \x1b[2mPress Ctrl+C to stop sharing.\x1b[0m");
  console.log("");

  const pty = attachSession(targetSession, cols, rows);

  await connectToRelay(relay, sessionId, cryptoKey, pty);
}

async function createSession(relay: string): Promise<string> {
  const res = await fetch(`${relay}/api/sessions`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

async function connectToRelay(
  relay: string,
  sessionId: string,
  key: CryptoKey,
  pty: IPty
): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsUrl = relay.replace(/^http/, "ws") + `/api/sessions/${sessionId}/ws?role=host`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    let alive = true;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    ws.on("open", () => {
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30_000);

      const resizePayload = JSON.stringify({
        cols: pty.cols,
        rows: pty.rows,
      });
      sendEncrypted(ws, key, MSG_RESIZE, new TextEncoder().encode(resizePayload));
    });

    pty.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        sendEncrypted(ws, key, MSG_TERMINAL_OUTPUT, new TextEncoder().encode(data));
      }
    });

    pty.onExit(({ exitCode }) => {
      alive = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      ws.close();
      resolve();
    });

    ws.on("message", async (raw: ArrayBuffer | string) => {
      if (typeof raw === "string") {
        if (raw === "__fied_ping__") {
          ws.send("__fied_pong__");
        }
        return;
      }

      try {
        const data = new Uint8Array(raw);
        const frame = parseFrame(data);

        if (frame.type === MSG_TERMINAL_INPUT) {
          const plaintext = await decrypt(key, frame.iv, frame.ciphertext);
          pty.write(new TextDecoder().decode(plaintext));
        } else if (frame.type === MSG_RESIZE) {
          const plaintext = await decrypt(key, frame.iv, frame.ciphertext);
          const { cols, rows } = JSON.parse(new TextDecoder().decode(plaintext));
          pty.resize(cols, rows);
        }
      } catch (err) {
        console.error("Failed to process incoming message:", err);
      }
    });

    ws.on("close", () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (alive) {
        pty.kill();
      }
      resolve();
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });

    process.on("SIGINT", () => {
      alive = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      ws.close();
      pty.kill();
    });

    process.on("SIGTERM", () => {
      alive = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      ws.close();
      pty.kill();
    });
  });
}

async function sendEncrypted(
  ws: WebSocket,
  key: CryptoKey,
  type: number,
  plaintext: Uint8Array
): Promise<void> {
  try {
    const { iv, ciphertext } = await encrypt(key, plaintext);
    const frame = frameMessage(type, iv, ciphertext);
    ws.send(frame);
  } catch (err) {
    console.error("Encryption failed:", err);
  }
}
