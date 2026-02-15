import { spawn, type IPty } from "node-pty";
import { execSync } from "node:child_process";

export interface TmuxSession {
  name: string;
  id: string;
  windows: number;
  attached: boolean;
  size: { cols: number; rows: number };
}

export function listSessions(): TmuxSession[] {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_width}\t#{session_height}"',
      { encoding: "utf-8" }
    ).trim();

    return output.split("\n").map((line) => {
      const [name, id, windows, attached, cols, rows] = line.split("\t");
      return {
        name,
        id,
        windows: parseInt(windows, 10),
        attached: parseInt(attached, 10) > 0,
        size: { cols: parseInt(cols, 10), rows: parseInt(rows, 10) },
      };
    });
  } catch {
    return [];
  }
}

export function attachSession(
  sessionName: string,
  cols: number,
  rows: number
): IPty {
  return spawn("tmux", ["attach-session", "-t", sessionName], {
    name: "xterm-256color",
    cols,
    rows,
    env: process.env as Record<string, string>,
  });
}
