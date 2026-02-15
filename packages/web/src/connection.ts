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

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface ConnectionCallbacks {
  onTerminalOutput: (data: Uint8Array) => void;
  onResize: (cols: number, rows: number) => void;
  onStateChange: (state: ConnectionState) => void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private backoff = 1000;
  private maxBackoff = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(
    private sessionId: string,
    private keyBase64Url: string,
    private callbacks: ConnectionCallbacks,
  ) {}

  async connect(): Promise<void> {
    this.intentionalClose = false;

    if (!this.key) {
      const rawKey = fromBase64Url(this.keyBase64Url);
      this.key = await importKey(rawKey);
    }

    this.callbacks.onStateChange("connecting");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/sessions/${this.sessionId}/ws?role=viewer`;

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

    this.ws.onerror = () => {};
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.key) return;

    const plaintext = this.encoder.encode(data);
    const { iv, ciphertext } = await encrypt(this.key, plaintext);
    const frame = frameMessage(MSG_TERMINAL_INPUT, iv, ciphertext);
    this.ws.send(frame.buffer);
  }

  async sendResize(cols: number, rows: number): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.key) return;

    const payload = this.encoder.encode(JSON.stringify({ cols, rows }));
    const { iv, ciphertext } = await encrypt(this.key, payload);
    const frame = frameMessage(MSG_RESIZE, iv, ciphertext);
    this.ws.send(frame.buffer);
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (!(data instanceof ArrayBuffer) || !this.key) return;

    try {
      const frame = parseFrame(new Uint8Array(data));

      switch (frame.type) {
        case MSG_TERMINAL_OUTPUT: {
          const plaintext = await decrypt(this.key, frame.iv, frame.ciphertext);
          this.callbacks.onTerminalOutput(plaintext);
          break;
        }

        case MSG_RESIZE: {
          const plaintext = await decrypt(this.key, frame.iv, frame.ciphertext);
          const { cols, rows } = JSON.parse(this.decoder.decode(plaintext));
          if (typeof cols === "number" && typeof rows === "number") {
            this.callbacks.onResize(cols, rows);
          }
          break;
        }


      }
    } catch {
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
