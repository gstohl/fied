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
    fontFamily:
      "ui-monospace, 'Cascadia Mono', 'Cascadia Code', 'SFMono-Regular', 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', 'Courier New', monospace",
    fontSize: 15,
    lineHeight: 1.15,
    theme: {
      background: "#000000",
      foreground: "#c7c7c7",
      cursor: "#c7c7c7",
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
