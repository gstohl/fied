import "@xterm/xterm/css/xterm.css";
import { createTerminal } from "./terminal";
import { Connection } from "./connection";

const landing = document.getElementById("landing")!;
const terminalContainer = document.getElementById("terminal-container")!;
const errorView = document.getElementById("error-view")!;
const copyCommandButton = document.getElementById("copy-cmd") as HTMLDivElement | null;
const mobileKeybar = document.getElementById("mobile-keybar") as HTMLDivElement | null;
const mobileKeybarToggle = document.getElementById("mobile-keybar-toggle") as HTMLButtonElement | null;
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

  let transformTerminalInput = (input: string) => input;

  const { terminal, fitAddon } = createTerminal(
    terminalContainer,
    (data) => connection.sendInput(transformTerminalInput(data)),
    (cols, rows) => connection.sendResize(cols, rows),
  );

  const applyViewportHeight = () => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    terminalContainer.style.height = `${Math.max(120, Math.floor(viewportHeight))}px`;
  };

  const syncViewport = () => {
    requestAnimationFrame(() => {
      applyViewportHeight();
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
  window.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);

  transformTerminalInput = setupMobileKeybar(terminalContainer, terminal, (input) => connection.sendInput(input));

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

function setupMobileKeybar(
  container: HTMLElement,
  terminal: { focus: () => void },
  sendInput: (input: string) => void,
): (input: string) => string {
  if (!mobileKeybar) return (input) => input;
  if (!mobileKeybarToggle) return (input) => input;

  const isTouch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  if (!isTouch) return (input) => input;

  const extraRow = mobileKeybar.querySelector(".mobile-row.extra") as HTMLDivElement | null;
  const ctrlButton = mobileKeybar.querySelector('[data-action="ctrl"]') as HTMLButtonElement | null;

  let ctrlArmed = false;
  let keybarEnabled = false;

  const setCtrlArmed = (armed: boolean) => {
    ctrlArmed = armed;
    if (ctrlButton) {
      ctrlButton.classList.toggle("active", armed);
      ctrlButton.setAttribute("aria-pressed", armed ? "true" : "false");
    }
  };

  const likelyKeyboardVisible = (): boolean => {
    const visualHeight = window.visualViewport?.height;
    if (!visualHeight) return false;
    return window.innerHeight - visualHeight > 120;
  };

  const updateVisibility = () => {
    const viewport = window.visualViewport;
    const occludedBottom = viewport
      ? Math.max(0, Math.round(window.innerHeight - (viewport.height + viewport.offsetTop)))
      : 0;
    mobileKeybar.style.bottom = `${occludedBottom}px`;

    const shouldShow = keybarEnabled && (likelyKeyboardVisible() || container.contains(document.activeElement));
    mobileKeybar.classList.toggle("visible", shouldShow);
    mobileKeybar.setAttribute("aria-hidden", shouldShow ? "false" : "true");
    mobileKeybarToggle.classList.toggle("active", keybarEnabled);
    mobileKeybarToggle.setAttribute("aria-pressed", keybarEnabled ? "true" : "false");
  };

  const applyCtrl = (input: string): string => {
    if (input === "\u001b[A") return "\u001b[1;5A";
    if (input === "\u001b[B") return "\u001b[1;5B";
    if (input === "\u001b[C") return "\u001b[1;5C";
    if (input === "\u001b[D") return "\u001b[1;5D";
    if (input === "\u001b[5~") return "\u001b[5;5~";
    if (input === "\u001b[6~") return "\u001b[6;5~";
    if (input.length === 1) {
      const upper = input.toUpperCase();
      if (upper >= "@" && upper <= "_") {
        return String.fromCharCode(upper.charCodeAt(0) - 64);
      }
    }
    return input;
  };

  const decodeDataInput = (input: string): string => {
    return input
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
  };

  const sendFromBar = (rawInput: string) => {
    const payload = transformInput(rawInput);
    sendInput(payload);
    terminal.focus();
  };

  const transformInput = (rawInput: string): string => {
    if (!ctrlArmed) {
      return rawInput;
    }

    const payload = applyCtrl(rawInput);
    setCtrlArmed(false);
    updateVisibility();
    return payload;
  };

  const buttons = Array.from(mobileKeybar.querySelectorAll("button"));
  for (const button of buttons) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });

    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      if (action === "ctrl") {
        setCtrlArmed(!ctrlArmed);
        terminal.focus();
        updateVisibility();
        return;
      }
      if (action === "toggle-extra") {
        if (extraRow) {
          extraRow.hidden = !extraRow.hidden;
        }
        terminal.focus();
        updateVisibility();
        return;
      }

      const rawInputAttr = button.getAttribute("data-input");
      if (!rawInputAttr) return;
      sendFromBar(decodeDataInput(rawInputAttr));
      updateVisibility();
    });
  }

  mobileKeybarToggle.addEventListener("click", () => {
    keybarEnabled = !keybarEnabled;
    if (!keybarEnabled) {
      setCtrlArmed(false);
      if (extraRow) {
        extraRow.hidden = true;
      }
    }
    terminal.focus();
    updateVisibility();
  });

  window.addEventListener("resize", updateVisibility);
  window.visualViewport?.addEventListener("resize", updateVisibility);
  window.visualViewport?.addEventListener("scroll", updateVisibility);
  document.addEventListener("focusin", updateVisibility);
  document.addEventListener("focusout", () => setTimeout(updateVisibility, 0));
  container.addEventListener("touchstart", () => {
    terminal.focus();
    updateVisibility();
  }, { passive: true });

  updateVisibility();
  return transformInput;
}
