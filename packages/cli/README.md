# fied

Share your tmux session in the browser. End-to-end encrypted.

```
npx fied
```

You get a link. Anyone with the link sees your terminal in real time and can type into it. The server never sees your data — the encryption key lives in the URL fragment (`#`), which never leaves the browser.

## How it works

```
tmux on your machine
  ↕ AES-256-GCM encrypted WebSocket
fied.app relay (sees only opaque bytes)
  ↕ AES-256-GCM encrypted WebSocket
Browser viewer (decrypts with key from URL #fragment)
```

1. `npx fied` attaches to your tmux session and generates a 256-bit AES key
2. You get a URL like `https://fied.app/s/a1b2c3d4#<key>`
3. The viewer opens the link, decrypts in-browser, renders via xterm.js
4. Keystrokes travel back the same encrypted path — fully interactive

## Usage

```bash
# Share the only tmux session (auto-detected)
npx fied

# Share a specific session
npx fied -s mysession

# Use a custom relay (self-hosted)
npx fied --relay https://your-relay.com
```

Running `npx fied` with no active share session opens a picker to select a tmux session. After the link is shown, you can send it to the background and manage active shares by running `npx fied` again.

## Requirements

- Node.js 18+
- A running tmux session

## Features

- **End-to-end encrypted** — AES-256-GCM, key never reaches the server
- **Interactive** — viewers can type, not just watch
- **Background mode** — share persists after closing the terminal
- **Session management** — list, stop, or reconnect to active shares
- **Mobile support** — works on phones and tablets
- **Up to 5 concurrent viewers** per session
- **Auto-reconnect** — survives brief network interruptions
- **Zero config** — just `npx fied`

## Security

- AES-256-GCM with random IV per message
- Key placed in URL fragment — [never sent to the server](https://datatracker.ietf.org/doc/html/rfc3986#section-3.5)
- Relay forwards opaque binary blobs
- All traffic over WSS (TLS)
- Rate-limited session creation

## Self-hosting

The relay is a Cloudflare Worker. See the [repo](https://github.com/gstohl/fied) for deployment instructions.

## License

MIT
