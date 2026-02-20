import {
  encrypt,
  decrypt,
  importKey,
  fromBase64Url,
  frameMessage,
  parseFrame,
} from "@fied/crypto";

const MSG_TERMINAL_OUTPUT = 0x01;
const MSG_TERMINAL_INPUT = 0x02;
const MSG_RESIZE = 0x03;

const RESIZE_MIN_COLS = 20;
const RESIZE_MAX_COLS = 1000;
const RESIZE_MIN_ROWS = 5;
const RESIZE_MAX_ROWS = 300;
const MAX_INVALID_RESIZE_FRAMES = 5;
const MAX_PROTOCOL_ERRORS = 8;

function typeAAD(type: number): Uint8Array {
  return new Uint8Array([type & 0xff]);
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface ConnectionCallbacks {
  onTerminalOutput: (data: Uint8Array) => void;
  onResize: (cols: number, rows: number) => void;
  onStateChange: (state: ConnectionState) => void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private readKey: CryptoKey | null = null;
  private writeKey: CryptoKey | null = null;
  private backoff = 1000;
  private maxBackoff = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private invalidResizeFrames = 0;
  private protocolErrors = 0;
  private readonlyViewer = false;

  constructor(
    private sessionId: string,
    private readKeyBase64Url: string,
    private writeKeyBase64Url: string | null,
    private callbacks: ConnectionCallbacks,
    readonly = false,
  ) {
    this.readonlyViewer = readonly;
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;

    if (!this.readKey) {
      const rawReadKey = fromBase64Url(this.readKeyBase64Url);
      this.readKey = await importKey(rawReadKey);
    }
    if (!this.writeKey && this.writeKeyBase64Url) {
      const rawWriteKey = fromBase64Url(this.writeKeyBase64Url);
      this.writeKey = await importKey(rawWriteKey);
    }

    this.callbacks.onStateChange("connecting");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const role = this.readonlyViewer ? "readonly" : "viewer";
    const url = `${proto}//${location.host}/api/sessions/${this.sessionId}/ws?role=${role}`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.backoff = 1000;
      this.callbacks.onStateChange("connected");
    };

    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data === "__fied_ping__") {
          this.ws?.send("__fied_pong__");
        }
        return;
      }
      this.handleMessage(ev.data);
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.intentionalClose) {
        this.callbacks.onStateChange("disconnected");
        this.scheduleReconnect();
      } else {
        this.callbacks.onStateChange("disconnected");
      }
    };

    this.ws.onerror = (event) => {
      console.warn("fied websocket error", event);
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async sendInput(data: string): Promise<void> {
    if (this.readonlyViewer) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.writeKey) return;

    const payload = this.encoder.encode(JSON.stringify({ nonce: crypto.randomUUID(), data }));
    const { iv, ciphertext } = await encrypt(this.writeKey, payload, typeAAD(MSG_TERMINAL_INPUT));
    const frame = frameMessage(MSG_TERMINAL_INPUT, iv, ciphertext);
    this.ws.send(frame.buffer);
  }

  async sendResize(cols: number, rows: number): Promise<void> {
    if (this.readonlyViewer) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.writeKey) return;
    if (!isValidResize(cols, rows)) return;

    const payload = this.encoder.encode(JSON.stringify({ nonce: crypto.randomUUID(), cols, rows }));
    const { iv, ciphertext } = await encrypt(this.writeKey, payload, typeAAD(MSG_RESIZE));
    const frame = frameMessage(MSG_RESIZE, iv, ciphertext);
    this.ws.send(frame.buffer);
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (!(data instanceof ArrayBuffer) || !this.readKey) return;

    try {
      const frame = parseFrame(new Uint8Array(data));

      switch (frame.type) {
        case MSG_TERMINAL_OUTPUT: {
          const plaintext = await decrypt(this.readKey, frame.iv, frame.ciphertext, typeAAD(frame.type));
          this.callbacks.onTerminalOutput(plaintext);
          break;
        }

        case MSG_RESIZE: {
          const plaintext = await decrypt(this.readKey, frame.iv, frame.ciphertext, typeAAD(frame.type));
          const resize = parseResizePayload(this.decoder.decode(plaintext));
          if (!resize) {
            this.invalidResizeFrames += 1;
            if (this.invalidResizeFrames >= MAX_INVALID_RESIZE_FRAMES) {
              console.warn("fied invalid resize threshold reached; disconnecting");
              this.disconnect();
            }
            break;
          }

          this.invalidResizeFrames = 0;
          this.callbacks.onResize(resize.cols, resize.rows);
          break;
        }


      }
    } catch (err) {
      this.protocolErrors += 1;
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`fied frame handling error (${this.protocolErrors}/${MAX_PROTOCOL_ERRORS}): ${detail}`);
      if (this.protocolErrors >= MAX_PROTOCOL_ERRORS) {
        console.warn("fied protocol error threshold reached; disconnecting");
        this.disconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);

    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }
}

function isValidResize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= RESIZE_MIN_COLS &&
    cols <= RESIZE_MAX_COLS &&
    rows >= RESIZE_MIN_ROWS &&
    rows <= RESIZE_MAX_ROWS
  );
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
  if (typeof typed.cols !== "number" || typeof typed.rows !== "number") return null;
  if (!isValidResize(typed.cols, typed.rows)) return null;
  return { cols: typed.cols, rows: typed.rows };
}
