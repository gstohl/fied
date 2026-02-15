# fied

Share your tmux session in the browser. End-to-end encrypted.

```
npx fied
```

That's it. You get a link. Anyone with the link sees your terminal in real time and can type into it. The server never sees your data — encryption keys live in the URL fragment (`#`), which never leaves the browser.

## How it works

```
CLI (your tmux session)
  <-> encrypted WebSocket bytes
fied.app relay (Cloudflare Worker + Durable Object)
  <-> encrypted WebSocket bytes
Browser viewer (xterm.js + in-browser decrypt with key from #fragment)
```

1. `npx fied` attaches to your tmux session, generates a 256-bit AES key, and connects to the relay
2. You get a URL like `https://fied.app/s/a1b2c3d4#<base64url-key>`
3. The viewer opens the link, decrypts in-browser, renders in xterm.js
4. Keystrokes travel back the same way — encrypted end-to-end

The relay on `fied.app` is a Cloudflare Worker + Durable Objects. It routes encrypted WebSocket messages between host and viewers. It never has the key.

## Usage

```bash
# Share the only tmux session (auto-detected)
npx fied

# Share a specific session
npx fied -s mysession

# Use a custom relay (self-hosted)
npx fied --relay http://localhost:8787 --allow-insecure-relay
```

### Requirements

- Node.js 18+
- A running tmux session (`tmux new -s work`)

## Self-hosting the relay

The relay is a Cloudflare Worker. To deploy your own:

```bash
cd packages/relay
npx wrangler deploy
```

Then point the CLI at it:

```bash
npx fied --relay https://your-worker.your-domain.com
```

## Architecture

| Package | What it does |
|---------|-------------|
| `packages/crypto` | AES-256-GCM encryption, key generation, wire protocol framing |
| `packages/cli` | CLI tool — attaches to tmux via node-pty, encrypts I/O, connects to relay |
| `packages/relay` | Cloudflare Worker + Durable Objects — routes encrypted WebSocket messages |
| `packages/web` | Browser viewer — xterm.js, decrypts with key from URL fragment |

## Security

- AES-256-GCM with random IVs per message
- Key is generated on your machine and placed in the URL fragment (`#`)
- The `#fragment` is never sent to the server ([RFC 3986](https://datatracker.ietf.org/doc/html/rfc3986#section-3.5))
- The relay forwards opaque binary blobs — it cannot read your terminal
- All traffic is over WSS (TLS)

## License

MIT
