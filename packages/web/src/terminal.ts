import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

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
      "Menlo, Monaco, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', 'Courier New', monospace",
    fontSize: 14,
    lineHeight: 1.08,
    fontWeight: "400",
    letterSpacing: 0,
    macOptionClickForcesSelection: true,
    theme: {
      background: "#000000",
      foreground: "#c7c7c7",
      cursor: "#c7c7c7",
      selectionBackground: "rgba(128, 160, 255, 0.35)",
      selectionInactiveBackground: "rgba(128, 160, 255, 0.22)",
    },
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  terminal.open(container);

  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });
    terminal.loadAddon(webglAddon);
  } catch {
    // WebGL unavailable — falls back to canvas renderer
  }

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
