import "@xterm/xterm/css/xterm.css";
import { createTerminal } from "./terminal";
import { Connection, ConnectionState } from "./connection";

const statusDot = document.getElementById("status-dot")!;
const statusText = document.getElementById("status-text")!;
const reconnectBtn = document.getElementById("reconnect-btn")! as HTMLButtonElement;
const terminalContainer = document.getElementById("terminal-container")!;
const errorView = document.getElementById("error-view")!;

function showError(title: string, detail: string): void {
  terminalContainer.style.display = "none";
  errorView.style.display = "flex";
  errorView.querySelector(".error-title")!.textContent = title;
  errorView.querySelector(".error-detail")!.textContent = detail;
}

function updateStatus(state: ConnectionState): void {
  statusDot.className = `status-dot ${state}`;

  switch (state) {
    case "connecting":
      statusText.textContent = "connecting\u2026";
      reconnectBtn.style.display = "none";
      break;
    case "connected":
      statusText.textContent = "connected (encrypted)";
      reconnectBtn.style.display = "none";
      break;
    case "disconnected":
      statusText.textContent = "disconnected";
      reconnectBtn.style.display = "inline-block";
      break;
  }
}

function parseRoute(): { sessionId: string; keyBase64Url: string } | null {
  const pathMatch = location.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/);
  if (!pathMatch) return null;

  const hash = location.hash.slice(1);
  if (!hash) return null;

  return { sessionId: pathMatch[1], keyBase64Url: hash };
}

async function main(): Promise<void> {
  const route = parseRoute();
  if (!route) {
    showError(
      "invalid session link",
      "Expected URL format: /s/SESSION_ID#ENCRYPTION_KEY — check the link you were given.",
    );
    return;
  }

  const { terminal, fitAddon } = createTerminal(
    terminalContainer,
    (data) => connection.sendInput(data),
    (cols, rows) => connection.sendResize(cols, rows),
  );

  const connection = new Connection(route.sessionId, route.keyBase64Url, {
    onTerminalOutput: (data) => terminal.write(data),
    onResize: (cols, rows) => {
      terminal.resize(cols, rows);
      requestAnimationFrame(() => fitAddon.fit());
    },
    onStateChange: updateStatus,
  });

  reconnectBtn.addEventListener("click", () => {
    connection.disconnect();
    connection.connect();
  });

  terminal.focus();
  await connection.connect();
}

main();
