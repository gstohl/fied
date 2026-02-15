import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export interface TerminalHandle {
  terminal: Terminal;
  fitAddon: FitAddon;
  dispose: () => void;
}

export function createTerminal(
  container: HTMLElement,
  onData: (data: string) => void,
  onResize: (cols: number, rows: number) => void,
): TerminalHandle {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: 14,
    lineHeight: 1.35,
    letterSpacing: 0.3,
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "rgba(122, 162, 247, 0.25)",
      selectionForeground: "#c0caf5",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  terminal.open(container);
  fitAddon.fit();

  terminal.onData(onData);

  terminal.onResize(({ cols, rows }) => {
    onResize(cols, rows);
  });

  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
      }
    });
  });
  resizeObserver.observe(container);

  const dispose = () => {
    resizeObserver.disconnect();
    terminal.dispose();
  };

  return { terminal, fitAddon, dispose };
}
