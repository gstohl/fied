import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { createTerminal } from "./terminal";
import { Connection } from "./connection";

const landing = document.getElementById("landing")!;
const terminalContainer = document.getElementById("terminal-container")!;
const errorView = document.getElementById("error-view")!;
const copyCommandButton = document.getElementById("copy-cmd") as HTMLDivElement | null;
const mobileKeybar = document.getElementById("mobile-keybar") as HTMLDivElement | null;
const mobileKeybarToggle = document.getElementById("mobile-keybar-toggle") as HTMLButtonElement | null;
const connectionStatus = document.getElementById("connection-status")!;
const outputDecoder = new TextDecoder("utf-8");

function showError(title: string, detail: string): void {
  errorView.style.display = "flex";
  errorView.querySelector(".error-title")!.textContent = title;
  errorView.querySelector(".error-detail")!.textContent = detail;
}

type Route =
  | { type: "landing" }
  | { type: "session"; sessionId: string; keyBase64Url: string; readonly: boolean }
  | { type: "invalid" };

function parseRoute(): Route {
  const isSessionPath = location.pathname.match(/^\/s\//);
  if (!isSessionPath) return { type: "landing" };

  const pathMatch = location.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)(?:\/(v))?\/?$/);
  const hash = location.hash.slice(1);
  if (!pathMatch || !hash) return { type: "invalid" };

  return {
    type: "session",
    sessionId: pathMatch[1],
    keyBase64Url: hash,
    readonly: pathMatch[2] === "v",
  };
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

  const { terminal, fitAddon, searchAddon } = createTerminal(
    terminalContainer,
    route.readonly ? () => {} : (data) => connection.sendInput(transformTerminalInput(data)),
    (cols, rows) => connection.sendResize(cols, rows),
  );

  if (route.readonly) {
    terminal.options.cursorBlink = false;
    terminal.options.cursorStyle = "underline";
    terminal.options.disableStdin = true;
  }

  const applyViewportHeight = () => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    terminalContainer.style.height = `${Math.max(120, Math.floor(viewportHeight))}px`;
  };

  const syncViewport = () => {
    requestAnimationFrame(() => {
      applyViewportHeight();
      fitAddon.fit();
    });
  };

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSyncViewport = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncViewport, 150);
  };

  const connection = new Connection(
    route.sessionId,
    route.keyBase64Url,
    {
      onTerminalOutput: (data) => terminal.write(normalizeTerminalOutput(data)),
      onResize: (cols, rows) => {
        terminal.resize(cols, rows);
        requestAnimationFrame(() => fitAddon.fit());
      },
      onStateChange: (state) => {
        connectionStatus.className = "";
        if (state === "connected") {
          connectionStatus.textContent = "";
          syncViewport();
        } else if (state === "connecting") {
          connectionStatus.textContent = "connecting\u2026";
          connectionStatus.className = "visible connecting";
        } else {
          connectionStatus.textContent = "disconnected \u2014 reconnecting\u2026";
          connectionStatus.className = "visible disconnected";
        }
      },
    },
    route.readonly,
  );

  window.addEventListener("load", syncViewport, { once: true });
  window.addEventListener("resize", debouncedSyncViewport);
  window.visualViewport?.addEventListener("resize", debouncedSyncViewport);
  window.visualViewport?.addEventListener("scroll", debouncedSyncViewport);

  if (route.readonly) {
    if (mobileKeybarToggle) {
      mobileKeybarToggle.style.display = "none";
    }
  } else {
    transformTerminalInput = setupMobileKeybar(terminalContainer, terminal, (input) => connection.sendInput(input));
  }

  setupSearch(searchAddon, terminal);

  if (!route.readonly) {
    terminal.focus();
  }
  await connection.connect();
}

main();

function normalizeTerminalOutput(data: Uint8Array): string {
  let text = outputDecoder.decode(data, { stream: true });
  text = text.replace(/\u23FA/g, "\u23FA\uFE0E");
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
  const altButton = mobileKeybar.querySelector('[data-action="alt"]') as HTMLButtonElement | null;

  let ctrlArmed = false;
  let altArmed = false;
  let keybarEnabled = false;

  const setCtrlArmed = (armed: boolean) => {
    ctrlArmed = armed;
    if (ctrlButton) {
      ctrlButton.classList.toggle("active", armed);
      ctrlButton.setAttribute("aria-pressed", armed ? "true" : "false");
    }
  };

  const setAltArmed = (armed: boolean) => {
    altArmed = armed;
    if (altButton) {
      altButton.classList.toggle("active", armed);
      altButton.setAttribute("aria-pressed", armed ? "true" : "false");
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

  const applyAlt = (input: string): string => {
    return `\u001b${input}`;
  };

  const transformInput = (rawInput: string): string => {
    let result = rawInput;

    if (ctrlArmed) {
      result = applyCtrl(result);
      setCtrlArmed(false);
    }

    if (altArmed) {
      result = applyAlt(result);
      setAltArmed(false);
    }

    if (rawInput !== result) {
      updateVisibility();
    }

    return result;
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
      if (action === "alt") {
        setAltArmed(!altArmed);
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
      setAltArmed(false);
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

function setupSearch(searchAddon: SearchAddon, terminal: Terminal): void {
  const bar = document.getElementById("search-bar")!;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const count = document.getElementById("search-count")!;
  const prevBtn = document.getElementById("search-prev")!;
  const nextBtn = document.getElementById("search-next")!;
  const closeBtn = document.getElementById("search-close")!;

  const searchOpts = {
    incremental: true,
    decorations: {
      matchBackground: "#3a3a00",
      activeMatchBackground: "#7a5a00",
      matchOverviewRuler: "#7dcfff",
      activeMatchColorOverviewRuler: "#7dcfff",
    },
  };

  const openSearch = () => {
    bar.classList.add("visible");
    input.focus();
    input.select();
  };

  const closeSearch = () => {
    bar.classList.remove("visible");
    input.value = "";
    count.textContent = "";
    count.classList.remove("has-results");
    searchAddon.clearDecorations();
    terminal.focus();
  };

  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (resultCount === 0) {
      count.textContent = input.value ? "0 results" : "";
      count.classList.remove("has-results");
    } else {
      count.textContent = `${resultIndex + 1} of ${resultCount}`;
      count.classList.add("has-results");
    }
  });

  input.addEventListener("input", () => {
    if (input.value) {
      searchAddon.findNext(input.value, searchOpts);
    } else {
      searchAddon.clearDecorations();
      count.textContent = "";
      count.classList.remove("has-results");
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      if (input.value) searchAddon.findPrevious(input.value, searchOpts);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (input.value) searchAddon.findNext(input.value, searchOpts);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  });

  prevBtn.addEventListener("click", () => {
    if (input.value) searchAddon.findPrevious(input.value, searchOpts);
    input.focus();
  });

  nextBtn.addEventListener("click", () => {
    if (input.value) searchAddon.findNext(input.value, searchOpts);
    input.focus();
  });

  closeBtn.addEventListener("click", closeSearch);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      openSearch();
    }
  });
}
