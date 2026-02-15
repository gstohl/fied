/**
 * Wire protocol for fied messages.
 *
 * All messages are binary (ArrayBuffer) with this layout:
 *   [1 byte type] [12 bytes IV] [N bytes ciphertext + 16 bytes AES-GCM tag]
 *
 * The ciphertext contains the plaintext message.
 * For TERMINAL_OUTPUT / TERMINAL_INPUT, plaintext is raw terminal bytes.
 * For RESIZE, plaintext is JSON: { cols: number, rows: number }
 */

export const enum MessageType {
  /** Terminal output from host → viewer(s) */
  TERMINAL_OUTPUT = 0x01,
  /** Terminal input from viewer → host */
  TERMINAL_INPUT = 0x02,
  /** Terminal resize event (bidirectional) */
  RESIZE = 0x03,
  /** Heartbeat / keepalive */
  PING = 0x04,
  /** Heartbeat response */
  PONG = 0x05,
}

export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;
export const HEADER_LENGTH = 1 + IV_LENGTH;

/**
 * Frame a message: prepend type byte and IV, append ciphertext (which includes GCM tag).
 */
export function frameMessage(
  type: MessageType,
  iv: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const frame = new Uint8Array(1 + iv.byteLength + ciphertext.byteLength);
  frame[0] = type;
  frame.set(iv, 1);
  frame.set(ciphertext, 1 + iv.byteLength);
  return frame;
}

/**
 * Parse a framed message back into its components.
 */
export function parseFrame(data: Uint8Array): {
  type: MessageType;
  iv: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (data.byteLength < HEADER_LENGTH + TAG_LENGTH) {
    throw new Error(`Frame too short: ${data.byteLength} bytes`);
  }

  const type = data[0] as MessageType;
  const iv = data.slice(1, 1 + IV_LENGTH);
  const ciphertext = data.slice(1 + IV_LENGTH);

  return { type, iv, ciphertext };
}
