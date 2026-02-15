import "@xterm/xterm/css/xterm.css";
import { createTerminal } from "./terminal";
import { Connection } from "./connection";

const landing = document.getElementById("landing")!;
const terminalContainer = document.getElementById("terminal-container")!;
const errorView = document.getElementById("error-view")!;
const copyCommandButton = document.getElementById("copy-cmd") as HTMLDivElement | null;
const outputDecoder = new TextDecoder();

function showError(title: string, detail: string): void {
  errorView.style.display = "flex";
  errorView.querySelector(".error-title")!.textContent = title;
  errorView.querySelector(".error-detail")!.textContent = detail;
}

type Route =
  | { type: "landing" }
  | { type: "session"; sessionId: string; keyBase64Url: string }
  | { type: "invalid" };

function parseRoute(): Route {
  const isSessionPath = location.pathname.match(/^\/s\//);
  if (!isSessionPath) return { type: "landing" };

  const pathMatch = location.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)/);
  const hash = location.hash.slice(1);
  if (!pathMatch || !hash) return { type: "invalid" };

  return { type: "session", sessionId: pathMatch[1], keyBase64Url: hash };
}

async function main(): Promise<void> {
  const route = parseRoute();

  if (route.type === "landing") {
    landing.style.display = "flex";
    copyCommandButton?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("npx fied");
        copyCommandButton.classList.add("copied");
        setTimeout(() => copyCommandButton.classList.remove("copied"), 1500);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`fied copy failed: ${detail}`);
      }
    });
    return;
  }

  if (route.type === "invalid") {
    showError(
      "invalid session link",
      "Expected URL format: /s/SESSION_ID#ENCRYPTION_KEY — check the link you were given.",
    );
    return;
  }

  terminalContainer.style.display = "block";

  const { terminal, fitAddon } = createTerminal(
    terminalContainer,
    (data) => connection.sendInput(data),
    (cols, rows) => connection.sendResize(cols, rows),
  );

  const syncViewport = () => {
    requestAnimationFrame(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        connection.sendResize(dims.cols, dims.rows);
      }
    });
  };

  const connection = new Connection(route.sessionId, route.keyBase64Url, {
    onTerminalOutput: (data) => terminal.write(normalizeTerminalOutput(data)),
    onResize: (cols, rows) => {
      terminal.resize(cols, rows);
      requestAnimationFrame(() => fitAddon.fit());
    },
    onStateChange: (state) => {
      if (state === "connected") {
        syncViewport();
        setTimeout(syncViewport, 120);
        setTimeout(syncViewport, 500);
      }
    },
  });

  window.addEventListener("load", syncViewport, { once: true });

  terminal.focus();
  await connection.connect();
}

main();

function normalizeTerminalOutput(data: Uint8Array): string {
  let text = outputDecoder.decode(data);
  text = text.replace(/\u23FA/g, "\u23FA\uFE0E");
  const mouseModeOn = new RegExp(`${String.fromCharCode(27)}\\[\\?(1000|1002|1003|1005|1006|1015|1007)h`, "g");
  text = text.replace(mouseModeOn, "");
  return text;
}
